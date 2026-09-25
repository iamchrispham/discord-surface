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
  isAgentResultForWithdrawnRequest: () => false,
  db: {
    prepare: () => ({
      all: <T extends Record<string, unknown>>(..._parameters: unknown[]) => [] as T[]
    })
  },
  transaction: operation => operation(),
  directPostRows: () => [],
  directPostBindingCurrent: () => true,
  directPostOwnerIdentity: () => ({ ownerPid: 1, ownerStartTime: null, ownerCommand: null }),
  directPostOwnerAlive: () => false,
  receipt: () => {}
};

const handlers = createDirectPostHandlers({
  assertText: value => String(value),
  parseJson: () => null,
  StateCorruptError: class extends Error {},
  BindingError: class extends Error {},
  StaleGenerationError: class extends Error {},
  DIRECT_POST_ATTEMPT: 'direct-post-attempt',
  DIRECT_POST_OUTCOME: 'direct-post-outcome',
  DIRECT_POST_FILE_PREPARATION: 'direct-post-file-preparation',
  DIRECT_POST_OUTCOMES: ['sent', 'not_sent', 'rejected', 'rate_limited', 'unknown', 'stale'] as const,
  bindingMatchesExpected: () => true,
  now: () => new Date().toISOString()
});

const outcome: DirectPostOutcome = 'sent';
const claim = handlers.beginDirectPostPart(state, meta);
const recorded = handlers.recordDirectPostOutcome(state, meta.requestId, meta.attemptId, outcome, {
  messageId: 'message',
  status: 200,
  reason: 'accepted'
});
const rows = queryDirectPostRows({
  db: state.db,
  assertText: value => String(value),
  parseJson: () => ({ journal: 'direct-post-v1' }),
  StateCorruptError: class extends Error {},
  attemptKind: 'direct-post-attempt',
  outcomeKind: 'direct-post-outcome'
});
const event = { id: 'message', channelId: 'channel', guildId: 'guild', isBot: true, nonce: 'nonce' };
const malformedEvent: DirectPostEvent = {};

claim.status satisfies string;
recorded.outcome satisfies DirectPostOutcome;
handlers.excludeDirectPost(state, event);
handlers.excludeDirectPost(state, malformedEvent);
handlers.directPostOutcomeMatches(state, event, 'messageId', 'message');
const detachedExclude = handlers.excludeDirectPost;

// @ts-expect-error direct-post binding provider uses the existing agent provider vocabulary
const invalidBindingProvider: DirectPostBinding = { ...binding, provider: 'discord' };

// @ts-expect-error direct-post metadata provider uses the existing agent provider vocabulary
const invalidMetaProvider: DirectPostPartMeta = { ...meta, provider: 'discord' };

// @ts-expect-error direct-post outcome matching requires channel and guild identity
handlers.directPostOutcomeMatches(state, malformedEvent, 'messageId', 'message');

// @ts-expect-error direct-post outcome matching requires string channel identity
handlers.directPostOutcomeMatches(state, { ...event, channelId: 123 }, 'messageId', 'message');

// @ts-expect-error outcome detail cannot override the captured attempt ID
handlers.recordDirectPostOutcome(state, meta.requestId, meta.attemptId, outcome, { attemptId: 'other' });

// @ts-expect-error outcome detail cannot override the captured receipt journal
handlers.recordDirectPostOutcome(state, meta.requestId, meta.attemptId, outcome, { journal: 'other' });

const custodyDetail = {
  requestId: meta.requestId,
  inReplyTo: meta.inReplyTo,
  attemptId: meta.attemptId,
  sourcePath: meta.sourcePath,
  textHash: meta.textHash,
  operatorId: meta.operatorId,
  partHash: meta.partHash,
  channelId: meta.channelId,
  guildId: meta.guildId,
  provider: meta.provider,
  nativeId: meta.nativeId,
  generation: meta.generation,
  conductorId: meta.conductorId,
  repoKey: meta.repoKey,
  partIndex: meta.partIndex,
  partCount: meta.partCount,
  nonce: meta.nonce,
  binding: meta.binding,
  deliveryChannelId: 'delivery',
  journal: 'direct-post-v1',
  ownerPid: 1,
  ownerStartTime: null,
  ownerCommand: null
};

// @ts-expect-error outcome detail cannot override captured direct-post custody
handlers.recordDirectPostOutcome(state, meta.requestId, meta.attemptId, outcome, custodyDetail);

// @ts-expect-error excludeDirectPost requires its handler receiver when detached
detachedExclude(state, event);

void rows;
void invalidBindingProvider;
void invalidMetaProvider;

// @ts-expect-error direct-post outcomes use the persisted finite vocabulary
const invalidOutcome: DirectPostOutcome = 'delivered';
void invalidOutcome;
