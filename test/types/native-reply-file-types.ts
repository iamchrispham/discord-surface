import type { AgentProvider } from '../../src/agent-message';
import {
  NATIVE_REPLY_FILE_JOURNAL,
  NATIVE_REPLY_FILE_PHASES,
  createNativeReplyFileHandlers,
  nativeReplyFilePreparationKey,
  assertNativeReplyFileManifest,
  type NativeReplyFilePhase,
  type NativeReplyFilePreparation
} from '../../src/state/native-reply-file';

const dependencies = {
  BindingError: Error,
  AuthorizationError: Error,
  StaleGenerationError: Error,
  StateCorruptError: Error,
  MESSAGE_STATES: {
    SUBMITTED: 'submitted',
    DISPATCHING: 'dispatching',
    UNCERTAIN: 'uncertain',
    REPLIED: 'replied',
    REPLY_READY: 'reply_ready'
  },
  DIRECT_POST_FILE_PREPARATION: 'direct-post-file-preparation',
  REPLY_LIMIT: 4000,
  assertProvider: (value: unknown): asserts value is AgentProvider => { void value; },
  assertText: (value: unknown, _name: string, _max?: number): string => String(value),
  assertUuid: (value: unknown, _name?: string): string => String(value),
  parseJson: (_value: unknown, _fallback: unknown): null => null,
  safeDetail: (value: unknown): string => String(value),
  now: (): string => new Date().toISOString()
} satisfies Parameters<typeof createNativeReplyFileHandlers>[0];

const handlers = createNativeReplyFileHandlers(dependencies);
const prepare: typeof handlers.prepareNativeReplyFile = handlers.prepareNativeReplyFile;
const release: typeof handlers.releaseNativeReplyFilePreparation = handlers.releaseNativeReplyFilePreparation;
const lookup: typeof handlers.nativeReplyFilePreparation = handlers.nativeReplyFilePreparation;

const prepareInput: Parameters<typeof prepare>[1] = {
  provider: 'codex',
  messageId: 'message-id',
  nativeId: '11111111-1111-1111-1111-111111111111',
  generation: 1,
  stateDir: '/tmp',
  sourcePath: '/tmp/reply.txt',
  caption: 'Reply'
};

const preparation: NativeReplyFilePreparation = {
  journal: NATIVE_REPLY_FILE_JOURNAL,
  phase: NATIVE_REPLY_FILE_PHASES.ADMITTED,
  preparationId: 'preparation-id',
  messageId: 'message-id',
  sourcePath: '/tmp/reply.txt',
  stagedPath: '/tmp/staged-reply.txt',
  filename: 'reply.txt',
  size: 0,
  sha256: 'sha256',
  caption: 'Reply',
  captionHash: 'caption-hash',
  channelId: 'channel-id',
  guildId: 'guild-id',
  provider: 'codex',
  nativeId: '11111111-1111-1111-1111-111111111111',
  generation: 1,
  operatorId: 'operator-id',
  ownerPid: 1,
  ownerStartTime: null,
  ownerCommand: null
};

const phase: NativeReplyFilePhase = NATIVE_REPLY_FILE_PHASES.ADMITTED;
// @ts-expect-error native reply file phases are finite
const unsupportedPhase: NativeReplyFilePhase = 'sent';
const key: string = nativeReplyFilePreparationKey('native-reply-file', preparation.preparationId);
assertNativeReplyFileManifest(preparation);

const prepared = prepare(null as unknown as Parameters<typeof prepare>[0], prepareInput);
const admitted: NativeReplyFilePreparation | null = prepared;
const preparationId: Parameters<typeof release>[2] = preparation.preparationId;
const messageId: Parameters<typeof release>[1] = preparation.messageId;
const lookedUp: ReturnType<typeof lookup> = lookup(null as unknown as Parameters<typeof lookup>[0], messageId);

void admitted;
void lookedUp;
void preparationId;
void phase;
void unsupportedPhase;
void key;
