const test = require('node:test');
const assert = require('node:assert/strict');
const { SurfaceState, MESSAGE_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { CODEX_ID, fixture, waitForCondition, providers } = require('./surface-fixtures');

test('simulated: submitted recovery transfers custody to one live observer without redispatch', async () => {
  const { dir, db, state: initial } = fixture();
  let state = initial;
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  let sends = 0;
  let dispatches = 0;
  let observations = 0;
  let release;
  const channel = {
    messages: { fetch: async () => ({ react: async () => {} }) },
    async send() {
      sends += 1;
      return { id: '102' };
    }
  };
  await state.acceptDiscordMessage({ id: '101', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'already sent' });
  state.claimDispatch('101');
  state.markSubmitted('101', { file: '/tmp/recovered-session.jsonl', offset: 4 }, '[[discord-surface:101]]');
  state.close();
  state = new SurfaceState(db);
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() {
          dispatches += 1;
          throw new Error('submitted recovery must not redispatch');
        },
        async observe(_message, _outcome, options) {
          observations += 1;
          options.onCursor({ file: '/tmp/recovered-session.jsonl', offset: 8 });
          return new Promise(resolve => { release = resolve; });
        }
      }
    }
  });
  gateway.ready = true;
  const started = performance.now();
  await gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  assert.ok(performance.now() - started < 250);
  assert.equal(dispatches, 0);
  assert.equal(observations, 1);
  assert.equal(sends, 0);
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.SUBMITTED);
  release({ text: 'recovered reply' });
  for (let attempt = 0; attempt < 100 && state.getMessage('101').state !== MESSAGE_STATES.REPLIED; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(state.getMessage('101').state, MESSAGE_STATES.REPLIED);
  assert.equal(sends, 1);
  assert.equal(state.getMessage('101').observerCursor.offset, 8);
  await gateway.stop();
  state.close();
});

test('simulated: accepted recovery transfers submitted custody without blocking on the final', async () => {
  const { dir, db, state: initial } = fixture();
  let state = initial;
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  await state.acceptDiscordMessage({ id: '103', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'held before restart' });
  state.close();
  state = new SurfaceState(db);
  const sends = [];
  const reactions = [];
  let dispatches = 0;
  let observations = 0;
  let release;
  const channel = {
    messages: { fetch: async () => ({ react: async reaction => { reactions.push(reaction); } }) },
    async send(payload) {
      sends.push(payload);
      return { id: `sent-${sends.length}` };
    }
  };
  const client = {
    on() {},
    off() {},
    channels: { fetch: async () => channel },
    async destroy() {}
  };
  const gateway = new DiscordGateway({
    state,
    client,
    providers: {
      codex: {
        async dispatch() { dispatches += 1; return { status: 'submitted' }; },
        async observe(_message, _outcome, options) {
          observations += 1;
          options.onCursor({ file: '/tmp/accepted-recovery.jsonl', offset: 12 });
          return new Promise(resolve => { release = resolve; });
        }
      }
    }
  });
  gateway.ready = true;
  const started = performance.now();
  await gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  assert.ok(performance.now() - started < 250);
  assert.equal(dispatches, 1);
  assert.equal(observations, 1);
  assert.equal(state.getMessage('103').state, MESSAGE_STATES.SUBMITTED);
  assert.equal(sends.filter(payload => String(payload.content).startsWith('Receipt:')).length, 0);
  assert.deepEqual(reactions, ['📥']);
  release({ text: 'answer after recovery' });
  for (let attempt = 0; attempt < 100 && state.getMessage('103').state !== MESSAGE_STATES.REPLIED; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(state.getMessage('103').state, MESSAGE_STATES.REPLIED);
  assert.equal(sends.filter(payload => payload.content === 'answer after recovery').length, 1);
  assert.equal(state.getMessage('103').observerCursor.offset, 12);
  await gateway.stop();
  state.close();
});

test('simulated: recovered observer drains next accepted message for same native owner', async () => {
  const { dir, db, state: initial } = fixture();
  let state = initial;
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '104', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'first' });
  await new Promise(resolve => setTimeout(resolve, 2));
  state.acceptDiscordMessage({ id: '105', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'second' });
  state.close();
  state = new SurfaceState(db);

  const sends = [];
  const dispatches = [];
  const observations = [];
  const releases = [];
  const channel = {
    messages: { fetch: async () => ({ react: async () => {} }) },
    async send(payload) {
      sends.push(payload);
      return { id: `sent-${sends.length}` };
    }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} },
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message) {
          observations.push(message.id);
          return new Promise(resolve => releases.push(resolve));
        }
      }
    }
  });
  gateway.ready = true;

  await gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  assert.deepEqual(dispatches, ['104']);
  assert.deepEqual(observations, ['104']);
  assert.equal(state.getMessage('105').state, MESSAGE_STATES.ACCEPTED);

  releases[0]({ text: 'answer-one' });
  await waitForCondition(() => observations.length === 2);
  assert.deepEqual(dispatches, ['104', '105']);
  assert.deepEqual(observations, ['104', '105']);
  assert.equal(state.getMessage('104').state, MESSAGE_STATES.REPLIED);

  releases[1]({ text: 'answer-two' });
  await waitForCondition(() => state.getMessage('105').state === MESSAGE_STATES.REPLIED);
  assert.equal(sends.filter(payload => payload.content === 'answer-one').length, 1);
  assert.equal(sends.filter(payload => payload.content === 'answer-two').length, 1);
  await gateway.stop();
  state.close();
});

test('simulated: recovered queue tail stays held after native owner change', async () => {
  const { dir, db, state: initial } = fixture();
  let state = initial;
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir }, { intakeCutoff: '100' });
  state.acceptDiscordMessage({ id: '106', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'first' });
  await new Promise(resolve => setTimeout(resolve, 2));
  state.acceptDiscordMessage({ id: '107', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'second' });
  state.close();
  state = new SurfaceState(db);

  const dispatches = [];
  const observations = [];
  let release;
  const sends = [];
  const channel = {
    messages: { fetch: async () => ({ react: async () => {} }) },
    async send(payload) {
      sends.push(payload);
      return { id: `sent-${sends.length}` };
    }
  };
  const gateway = new DiscordGateway({
    state,
    client: { on() {}, off() {}, channels: { fetch: async () => channel }, async destroy() {} },
    providers: {
      codex: {
        async dispatch(message) {
          dispatches.push(message.id);
          return { status: 'submitted' };
        },
        async observe(message) {
          observations.push(message.id);
          return new Promise(resolve => { release = resolve; });
        }
      }
    }
  });
  gateway.ready = true;

  await gateway.reconcilePending(new Date(Date.now() + 1).toISOString());
  assert.deepEqual(dispatches, ['106']);
  assert.deepEqual(observations, ['106']);
  state.setConfig({ operatorId: 'revoked-owner' });
  release({ text: 'late owner reply' });
  await waitForCondition(() => state.getMessage('106').state === MESSAGE_STATES.SUBMITTED);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(dispatches, ['106']);
  assert.deepEqual(observations, ['106']);
  assert.equal(state.getMessage('107').state, MESSAGE_STATES.ACCEPTED);
  assert.equal(sends.filter(payload => payload.content === 'late owner reply').length, 0);
  await gateway.stop();
  state.close();
});
