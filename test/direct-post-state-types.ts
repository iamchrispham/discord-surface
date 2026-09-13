import {
  createDirectPostHandlers,
  queryDirectPostRows,
  type DirectPostBinding,
  type DirectPostEvent,
  type DirectPostOutcome,
  type DirectPostPartMeta,
  type DirectPostState
} from '../src/state/direct-post';

const binding: DirectPostBinding = {
  active: true,
  channelId: 'channel',
  guildId: 'guild',
  provider: 'codex',
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  generation: 1,
  conductorId: 'conductor',
  repoKey: 'repo:fixture'
};

const meta: DirectPostPartMeta = {
  requestId: 'request',
  inReplyTo: null,
  attemptId: 'attempt',
  sourcePath: '/tmp/message.txt',
  textHash: 'text-hash',
  operatorId: 'operator',
  partHash: 'part-hash',
  channelId: binding.channelId,
  guildId: binding.guildId,
  provider: binding.provider,
  nativeId: binding.nativeId,
  generation: binding.generation,
  conductorId: binding.conductorId,
  repoKey: binding.repoKey,
  partIndex: 0,
  partCount: 1,
  nonce: 'nonce',
  binding
};

const state: DirectPostState = {
  db: {
    prepare: () => ({
      all: <T extends Record<string, unknown>>(..._parameters: unknown[]) => [] as T[]
    })
  },
  transaction: operation => operation(),
  directPostRows: () => [],
  directPostBindingCurrent: () => true,
  directPostOwnerIdentity: () => ({}),
  receipt: () => {}
};

const handlers = createDirectPostHandlers({
  db: state.db,
  assertText: value => String(value),
  parseJson: () => null,
  StateCorruptError: class extends Error {},
  attemptKind: 'direct-post-attempt',
  outcomeKind: 'direct-post-outcome',
  BindingError: class extends Error {},
  StaleGenerationError: class extends Error {},
  DIRECT_POST_ATTEMPT: 'direct-post-attempt',
  DIRECT_POST_OUTCOME: 'direct-post-outcome',
  DIRECT_POST_OUTCOMES: ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale'] as const,
  bindingMatchesExpected: () => true,
  now: () => new Date().toISOString()
});

const outcome: DirectPostOutcome = 'sent';
const claim = handlers.beginDirectPostPart(state, meta);
const recorded = handlers.recordDirectPostOutcome(state, meta.requestId, meta.attemptId, outcome);
const rows = queryDirectPostRows({
  db: state.db,
  assertText: value => String(value),
  parseJson: () => ({ journal: 'direct-post-v1' }),
  StateCorruptError: class extends Error {},
  attemptKind: 'direct-post-attempt',
  outcomeKind: 'direct-post-outcome'
});
const event: DirectPostEvent = { id: 'message', channelId: 'channel', guildId: 'guild', isBot: true, nonce: 'nonce' };

claim.status satisfies string;
recorded.outcome satisfies DirectPostOutcome;
handlers.excludeDirectPost(state, event);
void rows;

// @ts-expect-error direct-post outcomes use the persisted finite vocabulary
const invalidOutcome: DirectPostOutcome = 'delivered';
void invalidOutcome;
