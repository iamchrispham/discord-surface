const test = require('node:test');
const assert = require('node:assert/strict');

const { createReadinessHandlers } = require('../src/state/readiness');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');

const READS = [
  'getConfig',
  'listBindings',
  'listMessages',
  'listIntakeWatermarks',
  'listThreadEnrollments',
  'listTopicPublications',
  'listReceipts'
];
const EMPTY_LIMITS = Object.freeze({});
const CONFIG = Object.freeze({ operatorId: 'operator', guildId: 'guild', secretFile: '/tmp/secret' });

function jsonParser(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function makeReceiver({ config = {}, bindings = [], messages = [], watermarks = [], threadEnrollments = [], topicPublications = [], receipts = [] } = {}) {
  const order = [];
  const mark = name => { order.push(name); };
  return {
    order,
    getConfig() { mark('getConfig'); return config; },
    listBindings() { mark('listBindings'); return bindings; },
    listMessages() { mark('listMessages'); return messages; },
    listIntakeWatermarks() { mark('listIntakeWatermarks'); return watermarks; },
    listThreadEnrollments() { mark('listThreadEnrollments'); return threadEnrollments; },
    listTopicPublications() { mark('listTopicPublications'); return topicPublications; },
    listReceipts() { mark('listReceipts'); return receipts; }
  };
}

function invoke(fixtures) {
  const receiver = makeReceiver(fixtures);
  const handlers = createReadinessHandlers({ parseJson: jsonParser, THREAD_STATES, MESSAGE_STATES, RECOVERY_LIMITS: EMPTY_LIMITS });
  const result = handlers.getReadiness.call(receiver);
  return { receiver, result };
}

function expected({
  configured = false,
  activeBindings = 0,
  inactiveBindings = 0,
  pending = 0,
  uncertain = 0,
  unknownDelivery = 0,
  execution = 'unavailable',
  connectionBackfill = 'pending',
  intakeWatermarks = [],
  threadEnrollments = [],
  legacyTopicPublications = [],
  legacyTopicPublicationCustody = [],
  recovery = EMPTY_LIMITS
} = {}) {
  return {
    configured,
    activeBindings,
    inactiveBindings,
    pending,
    uncertain,
    unknownDelivery,
    execution,
    limits: {
      permission: 'unverified-live',
      nativeApproval: 'unverified-live',
      quota: 'unverified-live',
      billing: 'unverified-live',
      connectionBackfill,
      recovery
    },
    intakeWatermarks,
    threadEnrollments,
    legacyTopicPublications,
    legacyTopicPublicationCustody
  };
}

function watermark(overrides = {}) {
  return {
    channel_id: 'channel',
    last_seen_id: '10',
    recovered_through_id: '9',
    state: 'current',
    gap_from: null,
    gap_to: null,
    detail: null,
    ...overrides
  };
}

function projectWatermark(row) {
  return {
    channelId: row.channel_id,
    lastSeenId: row.last_seen_id,
    recoveredThroughId: row.recovered_through_id,
    state: row.state,
    gapFrom: row.gap_from,
    gapTo: row.gap_to,
    detail: row.detail
  };
}

function enrollment(overrides = {}) {
  return { threadId: 'thread', active: true, state: THREAD_STATES.READY, ...overrides };
}

function assertUntouched(inputs, before) {
  assert.deepStrictEqual(inputs, before);
}

function fixtureSet(parts) {
  const inputs = {
    config: CONFIG,
    bindings: [],
    messages: [],
    watermarks: [],
    threadEnrollments: [],
    topicPublications: [],
    receipts: [],
    ...parts
  };
  const before = structuredClone(inputs);
  deepFreeze(inputs);
  return { inputs, before };
}

test('facade forwards receiver and result through readiness owner', () => {
  const ownerPath = require.resolve('../src/state/readiness');
  const statePath = require.resolve('../src/state');
  const ownerEntry = require.cache[ownerPath];
  const ownerExports = ownerEntry.exports;
  const stateEntry = require.cache[statePath];
  const sentinelResult = { sentinel: true };
  let seen = null;
  try {
    ownerEntry.exports = {
      createReadinessHandlers() {
        return { getReadiness() { seen = this; return sentinelResult; } };
      }
    };
    delete require.cache[statePath];
    const fresh = require('../src/state');
    const receiver = {};
    const result = fresh.SurfaceState.prototype.getReadiness.call(receiver);
    assert.equal(result, sentinelResult);
    assert.equal(seen, receiver);
    assert.equal(typeof fresh.SurfaceState.prototype.getReadiness, 'function');
  } finally {
    ownerEntry.exports = ownerExports;
    require.cache[ownerPath] = ownerEntry;
    if (stateEntry) require.cache[statePath] = stateEntry;
    else delete require.cache[statePath];
  }
});

test('readiness preserves empty configuration and output key order', () => {
  const names = READS;
  const prior = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let globalReads = 0;
  try {
    for (const name of names) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: () => { globalReads++; return name === 'getConfig' ? {} : []; }
      });
    }
    for (const receiver of [undefined, null]) {
      assert.throws(() => SurfaceState.prototype.getReadiness.call(receiver), TypeError);
    }
    assert.equal(globalReads, 0);
  } finally {
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  const { inputs, before } = fixtureSet({ config: {} });
  const { receiver, result } = invoke(inputs);
  assert.deepStrictEqual(receiver.order, READS);
  assert.deepStrictEqual(result, expected());
  assert.deepStrictEqual(Object.keys(result), [
    'configured',
    'activeBindings',
    'inactiveBindings',
    'pending',
    'uncertain',
    'unknownDelivery',
    'execution',
    'limits',
    'intakeWatermarks',
    'threadEnrollments',
    'legacyTopicPublications',
    'legacyTopicPublicationCustody'
  ]);
  assert.deepStrictEqual(Object.keys(result.limits), [
    'permission',
    'nativeApproval',
    'quota',
    'billing',
    'connectionBackfill',
    'recovery'
  ]);
  assertUntouched(inputs, before);
});

test('readiness counts binding and message states without mutation', () => {
  const bindings = [{ active: true }, { active: true }, { active: false }];
  const messages = [
    { state: MESSAGE_STATES.ACCEPTED },
    { state: MESSAGE_STATES.SUBMITTED },
    { state: MESSAGE_STATES.REPLY_READY },
    { state: MESSAGE_STATES.UNCERTAIN },
    { state: MESSAGE_STATES.REPLY_FAILED },
    { state: MESSAGE_STATES.REPLY_UNKNOWN },
    { state: MESSAGE_STATES.REPLIED },
    { state: MESSAGE_STATES.REJECTED }
  ];
  const watermarks = [watermark()];
  const threadEnrollments = [];
  const { inputs, before } = fixtureSet({ bindings, messages, watermarks, threadEnrollments });
  const { receiver, result } = invoke(inputs);
  assert.deepStrictEqual(receiver.order, READS);
  assert.deepStrictEqual(result, expected({
    configured: true,
    activeBindings: 2,
    inactiveBindings: 1,
    pending: 3,
    uncertain: 1,
    unknownDelivery: 2,
    execution: 'unverified-live',
    connectionBackfill: 'bounded-by-discord-watermark',
    intakeWatermarks: [projectWatermark(watermarks[0])],
    threadEnrollments
  }));
  assert.equal(result.threadEnrollments, threadEnrollments);
  assertUntouched(inputs, before);
});

test('readiness preserves source read order', () => {
  const { inputs, before } = fixtureSet({ bindings: [{ active: true }] });
  const { receiver, result } = invoke(inputs);
  assert.deepStrictEqual(receiver.order, READS);
  assert.deepStrictEqual(result, expected({
    configured: true,
    activeBindings: 1,
    execution: 'unverified-live',
    connectionBackfill: 'pending'
  }));
  assertUntouched(inputs, before);
});

test('readiness ignores inactive thread gaps and pending states', () => {
  const threadEnrollments = [
    enrollment({ active: false, state: THREAD_STATES.GAP, threadId: 'inactive-gap' }),
    enrollment({ active: false, state: THREAD_STATES.PENDING, threadId: 'inactive-pending' })
  ];
  const { inputs, before } = fixtureSet({ bindings: [{ active: true }], threadEnrollments });
  const { receiver, result } = invoke(inputs);
  assert.deepStrictEqual(receiver.order, READS);
  assert.deepStrictEqual(result, expected({
    configured: true,
    activeBindings: 1,
    execution: 'unverified-live',
    connectionBackfill: 'pending',
    threadEnrollments
  }));
  assert.equal(result.threadEnrollments, threadEnrollments);
  assertUntouched(inputs, before);
});

test('readiness preserves pending and active thread gap precedence', () => {
  const base = { bindings: [{ active: true }] };
  const noWatermark = invoke({ config: CONFIG, ...base, watermarks: [], threadEnrollments: [enrollment({ state: THREAD_STATES.READY })] });
  assert.deepStrictEqual(noWatermark.receiver.order, READS);
  assert.equal(noWatermark.result.limits.connectionBackfill, 'pending');

  const pendingRow = watermark({ state: 'pending' });
  const watermarkPending = invoke({ config: CONFIG, ...base, watermarks: [pendingRow], threadEnrollments: [] });
  assert.deepStrictEqual(watermarkPending.receiver.order, READS);
  assert.equal(watermarkPending.result.limits.connectionBackfill, 'pending');

  const activePending = invoke({ config: CONFIG, ...base, watermarks: [watermark()], threadEnrollments: [enrollment({ state: THREAD_STATES.PENDING })] });
  assert.deepStrictEqual(activePending.receiver.order, READS);
  assert.equal(activePending.result.limits.connectionBackfill, 'pending');

  const gapThreads = [enrollment({ state: THREAD_STATES.GAP })];
  const activeGap = invoke({ config: CONFIG, ...base, watermarks: [pendingRow], threadEnrollments: gapThreads });
  assert.deepStrictEqual(activeGap.receiver.order, READS);
  assert.deepStrictEqual(activeGap.result, expected({
    configured: true,
    activeBindings: 1,
    execution: 'unverified-live',
    connectionBackfill: 'unrecoverable-gap',
    intakeWatermarks: [projectWatermark(pendingRow)],
    threadEnrollments: gapThreads
  }));

  const unavailableThreads = [enrollment({ state: THREAD_STATES.UNAVAILABLE })];
  const activeUnavailable = invoke({ config: CONFIG, ...base, watermarks: [watermark()], threadEnrollments: unavailableThreads });
  assert.deepStrictEqual(activeUnavailable.receiver.order, READS);
  assert.equal(activeUnavailable.result.limits.connectionBackfill, 'unavailable');

  const mixedThreads = [enrollment({ state: THREAD_STATES.GAP }), enrollment({ state: THREAD_STATES.PENDING })];
  const mixed = invoke({ config: CONFIG, ...base, watermarks: [pendingRow], threadEnrollments: mixedThreads });
  assert.deepStrictEqual(mixed.receiver.order, READS);
  assert.equal(mixed.result.limits.connectionBackfill, 'unrecoverable-gap');
});

test('readiness preserves first watermark gap override', () => {
  const base = { bindings: [{ active: true }] };
  const firstUnavailable = watermark({ state: 'unavailable' });
  const secondGap = watermark({ state: 'gap' });
  const pendingRow = watermark({ state: 'pending' });
  const gapThreads = [enrollment({ state: THREAD_STATES.GAP })];
  const mixed = invoke({
    config: CONFIG,
    ...base,
    watermarks: [firstUnavailable, secondGap, pendingRow],
    threadEnrollments: gapThreads
  });
  assert.deepStrictEqual(mixed.receiver.order, READS);
  assert.deepStrictEqual(mixed.result, expected({
    configured: true,
    activeBindings: 1,
    execution: 'unverified-live',
    connectionBackfill: 'unavailable',
    intakeWatermarks: [projectWatermark(firstUnavailable), projectWatermark(secondGap), projectWatermark(pendingRow)],
    threadEnrollments: gapThreads
  }));

  const gapRow = watermark({ state: 'gap' });
  const unavailableThreads = [enrollment({ state: THREAD_STATES.UNAVAILABLE })];
  const watermarkGap = invoke({ config: CONFIG, ...base, watermarks: [gapRow], threadEnrollments: unavailableThreads });
  assert.deepStrictEqual(watermarkGap.receiver.order, READS);
  assert.equal(watermarkGap.result.limits.connectionBackfill, 'unrecoverable-gap');

  const unavailableRow = watermark({ state: 'unavailable' });
  const watermarkUnavailable = invoke({ config: CONFIG, ...base, watermarks: [unavailableRow], threadEnrollments: gapThreads });
  assert.deepStrictEqual(watermarkUnavailable.receiver.order, READS);
  assert.equal(watermarkUnavailable.result.limits.connectionBackfill, 'unavailable');
});

test('readiness preserves latest per-channel legacy receipt ordering', () => {
  const topicPublications = [{ channelId: 'custody' }];
  const receipts = [
    { id: 1, kind: 'topic-publication', detail: '{"channelId":"c1","variant":"first"}', created_at: 't1' },
    { id: 2, kind: 'agent-message', detail: '{"channelId":"ignored"}', created_at: 't2' },
    { id: 3, kind: 'topic-publication-reconciled', detail: '{"channelId":"c1","variant":"second"}', created_at: 't3' },
    { id: 4, kind: 'topic-publication', detail: '{not-json', created_at: 't4' },
    { id: 5, kind: 'topic-publication', detail: '{"channelId":"c2","variant":"only"}', created_at: 't5' }
  ];
  const threadEnrollments = [];
  const { inputs, before } = fixtureSet({ bindings: [{ active: true }], topicPublications, receipts, threadEnrollments });
  const { receiver, result } = invoke(inputs);
  assert.deepStrictEqual(receiver.order, READS);
  assert.deepStrictEqual(result, expected({
    configured: true,
    activeBindings: 1,
    execution: 'unverified-live',
    connectionBackfill: 'pending',
    legacyTopicPublications: [
      { channelId: 'c1', variant: 'second', recordedAt: 't3' },
      { channelId: 'c2', variant: 'only', recordedAt: 't5' }
    ],
    legacyTopicPublicationCustody: topicPublications
  }));
  assert.equal(result.legacyTopicPublicationCustody, topicPublications);
  assertUntouched(inputs, before);
});

test('readiness uses injected constants parser and recovery limits', () => {
  const CUSTOM_THREAD = Object.freeze({
    PENDING: 'injected-thread-pending',
    GAP: 'injected-thread-gap',
    UNAVAILABLE: 'injected-thread-unavailable'
  });
  const CUSTOM_MESSAGE = Object.freeze({
    ACCEPTED: 'injected-accepted',
    SUBMITTED: 'injected-submitted',
    REPLY_READY: 'injected-reply-ready',
    UNCERTAIN: 'injected-uncertain',
    REPLY_FAILED: 'injected-reply-failed',
    REPLY_UNKNOWN: 'injected-reply-unknown'
  });
  const CUSTOM_LIMITS = Object.freeze({ pageSize: 7, maxPages: 3, marker: 'injected' });
  for (const value of Object.values(CUSTOM_THREAD)) assert.equal(Object.values(THREAD_STATES).includes(value), false);
  for (const value of Object.values(CUSTOM_MESSAGE)) assert.equal(Object.values(MESSAGE_STATES).includes(value), false);

  const parseCalls = [];
  const spy = (value, fallback) => {
    parseCalls.push([value, fallback]);
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const bindings = [{ active: true }, { active: true }];
  const messages = [
    { state: CUSTOM_MESSAGE.ACCEPTED },
    { state: CUSTOM_MESSAGE.SUBMITTED },
    { state: CUSTOM_MESSAGE.UNCERTAIN },
    { state: CUSTOM_MESSAGE.REPLY_FAILED }
  ];
  const watermarks = [watermark()];
  const threadEnrollments = [enrollment({ state: CUSTOM_THREAD.PENDING })];
  const topicPublications = [{ channelId: 'custody' }];
  const receipts = [{ id: 1, kind: 'topic-publication', detail: '{malformed', created_at: 't1' }];
  const inputs = { config: CONFIG, bindings, messages, watermarks, threadEnrollments, topicPublications, receipts };
  const before = structuredClone(inputs);
  deepFreeze(inputs);

  const receiver = makeReceiver(inputs);
  const handlers = createReadinessHandlers({
    parseJson: spy,
    THREAD_STATES: CUSTOM_THREAD,
    MESSAGE_STATES: CUSTOM_MESSAGE,
    RECOVERY_LIMITS: CUSTOM_LIMITS
  });
  const result = handlers.getReadiness.call(receiver);
  assert.deepStrictEqual(receiver.order, READS);
  assert.deepStrictEqual(result, expected({
    configured: true,
    activeBindings: 2,
    pending: 2,
    uncertain: 1,
    unknownDelivery: 1,
    execution: 'unverified-live',
    connectionBackfill: 'pending',
    intakeWatermarks: [projectWatermark(watermarks[0])],
    threadEnrollments,
    legacyTopicPublications: [],
    legacyTopicPublicationCustody: topicPublications,
    recovery: CUSTOM_LIMITS
  }));
  assert.equal(result.limits.recovery, CUSTOM_LIMITS);
  assert.deepStrictEqual(parseCalls, [['{malformed', {}]]);
  assert.equal(result.threadEnrollments, threadEnrollments);
  assert.equal(result.legacyTopicPublicationCustody, topicPublications);
  assertUntouched(inputs, before);
});
