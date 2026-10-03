const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { planTownHallBroadcast } = require('../dist/peer/town-hall-plan');

const CHILD_DOMAIN = 'discord-surface/town-hall-child/v1';
const PLAN_DOMAIN = 'discord-surface/town-hall-plan/v1';
const PACKET_PREFIX = 'townhall_';
const INVALID = 'invalid town-hall broadcast plan';

const SOURCE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOURCE_UUID_UPPER = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const CODEX_UUID = '11111111-1111-4111-8111-aabbccddeeff';
const CODEX_UUID_UPPER = '11111111-1111-4111-8111-AABBCCDDEEFF';
const CLAUDE_UUID = '22222222-2222-4222-8222-222222222222';
const THIRD_UUID = '33333333-3333-4333-8333-333333333333';
const OTHER_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

function sha256hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  return {
    guildId: value.guildId,
    channelId: value.channelId,
    provider: value.provider,
    nativeId: value.nativeId.toLowerCase(),
    generation: value.generation
  };
}

function canonicalRoom(room) {
  return { guildId: room.guildId, channelId: room.channelId };
}

function targetKey(entry) {
  return JSON.stringify([entry.guildId, entry.channelId, entry.provider, entry.nativeId, entry.generation]);
}

function sortedCanonicalTargets(targets) {
  return targets.map(canonical).sort((left, right) => {
    const a = targetKey(left);
    const b = targetKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function expectedPacketId(broadcastId, source, target) {
  return PACKET_PREFIX + sha256hex(JSON.stringify([CHILD_DOMAIN, canonical(source), broadcastId, canonical(target)]));
}

function expectedFingerprint(broadcastId, townHall, source, text, targets) {
  return sha256hex(JSON.stringify([
    PLAN_DOMAIN,
    broadcastId,
    canonicalRoom(townHall),
    canonical(source),
    text,
    sortedCanonicalTargets(targets)
  ]));
}

function assertInvalid(run) {
  assert.throws(run, error => {
    assert.equal(error.message, INVALID);
    return true;
  });
}

test('emitted planner export resolves and builds one recipient', () => {
  assert.equal(typeof planTownHallBroadcast, 'function');
  const source = input();
  const plan = planTownHallBroadcast(source);

  assert.equal(plan.version, 1);
  assert.equal(plan.broadcastId, 'b1');
  assert.deepEqual(plan.townHall, { guildId: '100', channelId: '900' });
  assert.deepEqual(plan.source, canonical(source.source));
  assert.equal(plan.text, 'hello');
  assert.equal(plan.recipients.length, 1);
  assert.equal(plan.recipients[0].target.nativeId, CODEX_UUID);
  assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(plan.recipients[0].packetId, new RegExp(`^${PACKET_PREFIX}[a-f0-9]{64}$`));
  assert.equal(plan.recipients[0].packetId, expectedPacketId('b1', source.source, source.recipients[0]));
  assert.equal(plan.fingerprint, expectedFingerprint('b1', source.townHall, source.source, 'hello', source.recipients));

  assert.equal(JSON.stringify(Object.keys(plan)), JSON.stringify(['version', 'broadcastId', 'townHall', 'source', 'text', 'recipients', 'fingerprint']));
  assert.equal(JSON.stringify(Object.keys(plan.townHall)), JSON.stringify(['guildId', 'channelId']));
  assert.equal(JSON.stringify(Object.keys(plan.source)), JSON.stringify(['guildId', 'channelId', 'provider', 'nativeId', 'generation']));

  assert.notEqual(plan, source);
  assert.notEqual(plan.townHall, source.townHall);
  assert.notEqual(plan.source, source.source);
  assert.notEqual(plan.recipients, source.recipients);
  assert.notEqual(plan.recipients[0], source.recipients[0]);
  assert.notEqual(plan.recipients[0].target, source.recipients[0]);
});

test('same input produces identical plan', () => {
  const source = input();
  const first = planTownHallBroadcast(source);
  const second = planTownHallBroadcast(input());
  assert.deepEqual(first, second);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('recipient permutation produces identical sorted plan', () => {
  const recipients = [
    address({ channelId: '301', provider: 'claude', nativeId: CLAUDE_UUID }),
    address({ channelId: '300' }),
    address({ channelId: '302', nativeId: THIRD_UUID, generation: 2 })
  ];
  const forward = planTownHallBroadcast(input({ recipients }));
  const backward = planTownHallBroadcast(input({ recipients: [...recipients].reverse() }));
  assert.deepEqual(forward, backward);
  const order = forward.recipients.map(entry => targetKey(entry.target));
  assert.deepEqual(order, [...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test('UUID case canonicalizes without mutating input', () => {
  const sourceInput = input({
    source: address({ channelId: '200', nativeId: SOURCE_UUID_UPPER }),
    recipients: [address({ channelId: '300', nativeId: CODEX_UUID_UPPER })]
  });
  const plan = planTownHallBroadcast(sourceInput);
  assert.equal(plan.source.nativeId, SOURCE_UUID);
  assert.equal(plan.recipients[0].target.nativeId, CODEX_UUID);
  assert.equal(sourceInput.source.nativeId, SOURCE_UUID_UPPER);
  assert.equal(sourceInput.recipients[0].nativeId, CODEX_UUID_UPPER);

  const lowerPlan = planTownHallBroadcast(input({
    source: address({ channelId: '200', nativeId: SOURCE_UUID }),
    recipients: [address({ channelId: '300', nativeId: CODEX_UUID })]
  }));
  assert.deepEqual(plan, lowerPlan);
});

test('output and all nested plan values are frozen', () => {
  const plan = planTownHallBroadcast(input({
    recipients: [
      address({ channelId: '300' }),
      address({ channelId: '301', provider: 'claude', nativeId: CLAUDE_UUID, generation: 2 })
    ]
  }));
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.townHall));
  assert.ok(Object.isFrozen(plan.source));
  assert.ok(Object.isFrozen(plan.recipients));
  for (const entry of plan.recipients) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.target));
  }
});

test('caller input stays mutable and changes cannot alter plan', () => {
  const source = input();
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.townHall), false);
  assert.equal(Object.isFrozen(source.source), false);
  assert.equal(Object.isFrozen(source.recipients), false);
  assert.equal(Object.isFrozen(source.recipients[0]), false);

  const plan = planTownHallBroadcast(source);
  const before = JSON.stringify(plan);
  const expected = plan.fingerprint;

  source.source.nativeId = OTHER_UUID;
  source.source.channelId = '201';
  source.townHall.channelId = '901';
  source.text = 'mutated';
  source.recipients[0].channelId = '399';
  source.recipients.push(address({ channelId: '398', nativeId: THIRD_UUID }));

  assert.equal(JSON.stringify(plan), before);
  assert.equal(plan.source.nativeId, SOURCE_UUID);
  assert.equal(plan.source.channelId, '200');
  assert.equal(plan.townHall.channelId, '900');
  assert.equal(plan.text, 'hello');
  assert.equal(plan.recipients.length, 1);
  assert.equal(plan.recipients[0].target.channelId, '300');
  assert.equal(plan.fingerprint, expected);
  assert.equal(plan.fingerprint, expectedFingerprint('b1', { guildId: '100', channelId: '900' }, address({ channelId: '200', nativeId: SOURCE_UUID }), 'hello', [address({ channelId: '300' })]));
});

test('rejects missing and extra root fields', () => {
  const base = input();
  for (const value of [null, undefined, 42, 'x', [], {}]) {
    assertInvalid(() => planTownHallBroadcast(value));
  }
  for (const key of ['broadcastId', 'townHall', 'source', 'recipients', 'text']) {
    const missing = { ...base };
    delete missing[key];
    assertInvalid(() => planTownHallBroadcast(missing));
  }
  assertInvalid(() => planTownHallBroadcast({ ...base, extra: true }));

  let calls = 0;
  const accessor = { ...base };
  Object.defineProperty(accessor, 'text', {
    get() { calls += 1; return 'hello'; },
    enumerable: true,
    configurable: true
  });
  assertInvalid(() => planTownHallBroadcast(accessor));
  assert.equal(calls, 0);
});

test('rejects invalid broadcast identifiers', () => {
  const base = input();
  for (const broadcastId of ['', 'x'.repeat(129), 'has space', 'a/b', 'a.b', 123, null]) {
    assertInvalid(() => planTownHallBroadcast({ ...base, broadcastId }));
  }
});

test('rejects malformed room and room child collision', () => {
  const base = input();
  assertInvalid(() => planTownHallBroadcast({ ...base, townHall: { guildId: '100', channelId: '200' } }));
  assertInvalid(() => planTownHallBroadcast({ ...base, townHall: { guildId: '100', channelId: '300' } }));

  for (const townHall of [
    { guildId: '100' },
    { guildId: '100', channelId: '900', extra: true },
    { guildId: '100', channelId: 900 },
    { guildId: '100', channelId: '1'.repeat(21) },
    { guildId: '100', channelId: '' },
    { guildId: '1'.repeat(21), channelId: '900' },
    { guildId: '', channelId: '900' }
  ]) {
    assertInvalid(() => planTownHallBroadcast({ ...base, townHall }));
  }

  let calls = 0;
  const accessor = { guildId: '100' };
  Object.defineProperty(accessor, 'channelId', {
    get() { calls += 1; return '900'; },
    enumerable: true,
    configurable: true
  });
  assertInvalid(() => planTownHallBroadcast({ ...base, townHall: accessor }));
  assert.equal(calls, 0);
});

test('rejects invalid source and recipient address fields', () => {
  const base = input();
  const mutations = [
    value => { delete value.channelId; },
    value => { value.extra = true; },
    value => { value.provider = 'other'; },
    value => { value.nativeId = 'not-a-uuid'; },
    value => { value.generation = 0; },
    value => { value.generation = -1; },
    value => { value.generation = 1.5; },
    value => { value.generation = '1'; },
    value => { value.guildId = '1'.repeat(21); }
  ];
  for (const mutate of mutations) {
    const source = address({ channelId: '200', nativeId: SOURCE_UUID });
    mutate(source);
    assertInvalid(() => planTownHallBroadcast({ ...base, source }));
    const recipient = address({ channelId: '300' });
    mutate(recipient);
    assertInvalid(() => planTownHallBroadcast({ ...base, recipients: [recipient] }));
  }

  let calls = 0;
  const sourceAccessor = address({ channelId: '200', nativeId: SOURCE_UUID });
  Object.defineProperty(sourceAccessor, 'nativeId', {
    get() { calls += 1; return SOURCE_UUID; },
    enumerable: true,
    configurable: true
  });
  assertInvalid(() => planTownHallBroadcast({ ...base, source: sourceAccessor }));
  assert.equal(calls, 0);

  let recipientCalls = 0;
  const recipientAccessor = address({ channelId: '300' });
  Object.defineProperty(recipientAccessor, 'generation', {
    get() { recipientCalls += 1; return 1; },
    enumerable: true,
    configurable: true
  });
  assertInvalid(() => planTownHallBroadcast({ ...base, recipients: [recipientAccessor] }));
  assert.equal(recipientCalls, 0);
});

test('rejects empty and sparse audience arrays', () => {
  const base = input();
  assertInvalid(() => planTownHallBroadcast({ ...base, recipients: [] }));
  assertInvalid(() => planTownHallBroadcast({ ...base, recipients: new Array(3) }));
  const recipient = address({ channelId: '300' });
  const other = address({ channelId: '301', nativeId: THIRD_UUID });
  assertInvalid(() => planTownHallBroadcast({ ...base, recipients: [recipient, , other] }));
  for (const recipients of [{}, 'x']) {
    assertInvalid(() => planTownHallBroadcast({ ...base, recipients }));
  }
});

test('rejects duplicate native recipients across routes and generations', () => {
  const base = input();
  assertInvalid(() => planTownHallBroadcast({
    ...base,
    recipients: [address(), address({ nativeId: CODEX_UUID_UPPER })]
  }));
  assertInvalid(() => planTownHallBroadcast({
    ...base,
    recipients: [address({ channelId: '300' }), address({ channelId: '301' })]
  }));
  assertInvalid(() => planTownHallBroadcast({
    ...base,
    recipients: [address({ channelId: '300' }), address({ channelId: '301', generation: 2 })]
  }));
});

test('rejects source native identity as recipient across routes', () => {
  const base = input();
  assertInvalid(() => planTownHallBroadcast({
    ...base,
    recipients: [address({ channelId: '300', nativeId: SOURCE_UUID })]
  }));
  assertInvalid(() => planTownHallBroadcast({
    ...base,
    recipients: [address({ channelId: '300', nativeId: SOURCE_UUID, generation: 2 })]
  }));
});

test('rejects cross-guild source room and recipients', () => {
  const base = input();
  assertInvalid(() => planTownHallBroadcast({
    ...base,
    townHall: { guildId: '101', channelId: '900' }
  }));
  assertInvalid(() => planTownHallBroadcast({
    ...base,
    recipients: [address({ guildId: '101', channelId: '300' })]
  }));
});

test('rejects blank oversized and lossy UTF8 text', () => {
  const base = input();
  for (const text of ['', ' ', '\t\n', 'x'.repeat(10001), 'é'.repeat(5001), '\uD800']) {
    assertInvalid(() => planTownHallBroadcast({ ...base, text }));
  }
});

test('preserves exact text and accepts 10000-byte boundary', () => {
  const base = input();
  const padded = '  hi\n';
  assert.equal(planTownHallBroadcast({ ...base, text: padded }).text, padded);

  const ascii = 'a'.repeat(10000);
  assert.equal(Buffer.byteLength(ascii, 'utf8'), 10000);
  const asciiPlan = planTownHallBroadcast({ ...base, text: ascii });
  assert.equal(asciiPlan.text, ascii);

  const multibyte = 'é'.repeat(5000);
  assert.equal(Buffer.byteLength(multibyte, 'utf8'), 10000);
  const multibytePlan = planTownHallBroadcast({ ...base, text: multibyte });
  assert.equal(multibytePlan.text, multibyte);
  assert.equal(multibytePlan.fingerprint, planTownHallBroadcast({ ...base, text: multibyte }).fingerprint);
  assert.equal(multibytePlan.fingerprint, expectedFingerprint('b1', base.townHall, base.source, multibyte, base.recipients));
});

test('text room audience changes alter fingerprint but preserve existing child IDs', () => {
  const base = input();
  const basePlan = planTownHallBroadcast(base);

  const textPlan = planTownHallBroadcast({ ...base, text: 'changed text' });
  assert.equal(textPlan.recipients[0].packetId, basePlan.recipients[0].packetId);
  assert.notEqual(textPlan.fingerprint, basePlan.fingerprint);

  const roomPlan = planTownHallBroadcast({ ...base, townHall: { guildId: '100', channelId: '901' } });
  assert.equal(roomPlan.recipients[0].packetId, basePlan.recipients[0].packetId);
  assert.notEqual(roomPlan.fingerprint, basePlan.fingerprint);

  const grownPlan = planTownHallBroadcast({
    ...base,
    recipients: [base.recipients[0], address({ channelId: '301', provider: 'claude', nativeId: CLAUDE_UUID })]
  });
  const preserved = grownPlan.recipients.find(entry => entry.target.channelId === '300');
  assert.equal(preserved.packetId, basePlan.recipients[0].packetId);
  assert.notEqual(grownPlan.fingerprint, basePlan.fingerprint);
});

test('source broadcast ID and target generation changes alter child IDs', () => {
  const base = input();
  const basePlan = planTownHallBroadcast(base);

  const upperPlan = planTownHallBroadcast({
    ...base,
    source: address({ channelId: '200', nativeId: SOURCE_UUID_UPPER })
  });
  const lowerPlan = planTownHallBroadcast({
    ...base,
    source: address({ channelId: '200', nativeId: SOURCE_UUID })
  });
  assert.equal(upperPlan.recipients[0].packetId, lowerPlan.recipients[0].packetId);
  assert.equal(upperPlan.recipients[0].packetId, basePlan.recipients[0].packetId);

  const otherSource = planTownHallBroadcast({
    ...base,
    source: address({ channelId: '200', nativeId: OTHER_UUID })
  });
  assert.notEqual(otherSource.recipients[0].packetId, basePlan.recipients[0].packetId);

  const otherBroadcast = planTownHallBroadcast({ ...base, broadcastId: 'b2' });
  assert.notEqual(otherBroadcast.recipients[0].packetId, basePlan.recipients[0].packetId);

  const otherGeneration = planTownHallBroadcast({
    ...base,
    recipients: [address({ channelId: '300', generation: 2 })]
  });
  assert.notEqual(otherGeneration.recipients[0].packetId, basePlan.recipients[0].packetId);
});

test('malformed address IDs preserve normalized rejection without coercion', () => {
  let coercions = 0;
  const coercible = { get [Symbol.toPrimitive]() { coercions += 1; throw new Error('unexpected coercion'); } };
  for (const field of ['guildId', 'channelId']) {
    for (const value of [Symbol('invalid'), coercible]) {
      const base = input();
      assertInvalid(() => planTownHallBroadcast({ ...base, source: { ...base.source, [field]: value } }));
      assertInvalid(() => planTownHallBroadcast({ ...base, recipients: [{ ...base.recipients[0], [field]: value }] }));
    }
  }
  assert.equal(coercions, 0);
});
