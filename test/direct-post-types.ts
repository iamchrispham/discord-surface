import {
  readTextFile,
  requestIdFor,
  resolveDedupeKey,
  resolveDirectBinding,
  runDirectPost,
  type DirectPostBinding,
  type DirectPostInput,
  type DirectPostResult,
  type DirectPostState,
  type FetchImplementation
} from '../src/direct-post';

const binding: DirectPostBinding = {
  active: true,
  guildId: 'guild',
  channelId: 'channel',
  provider: 'codex',
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  generation: 1,
  conductorId: 'conductor',
  repoKey: 'repo:fixture'
};

const state: DirectPostState = {
  requireConfig: () => ({ guildId: binding.guildId, operatorId: 'operator' }),
  listBindings: () => [binding],
  isOrdinaryBinding: () => false,
  listReceipts: () => [],
  recoverDirectPostReceipts: () => undefined,
  inspectDirectPostPart: () => null,
  recordDirectPostPreflight: (_meta, outcome) => ({ outcome }),
  beginDirectPostPart: meta => ({ claimed: true, status: 'claimed', attemptId: meta.attemptId, nonce: meta.nonce }),
  directPostBindingCurrent: () => true,
  recordDirectPostOutcome: (_requestId, _attemptId, outcome) => ({ outcome, messageId: 'message' })
};

const fetchImpl: FetchImplementation = async (_url, _options) => ({
  ok: true,
  status: 200,
  json: async () => ({ id: 'message' })
});

// @ts-expect-error successful responses must provide JSON decoding
const incompleteFetchImpl: FetchImplementation = async (_url, _options) => ({ ok: true, status: 200 });

const input: DirectPostInput = {
  state,
  token: 'token',
  nativeId: binding.nativeId,
  generation: binding.generation,
  textFile: '/tmp/message.txt',
  fetchImpl
};

const result: Promise<DirectPostResult> = runDirectPost(input);
const sourcePath: string = readTextFile(input.textFile).sourcePath;
const dedupeKey: string | undefined = resolveDedupeKey({ dedupeKey: 'request' });
const requestId: string = requestIdFor(binding, 'operator', sourcePath, 'hash', dedupeKey);
const resolvedBinding: DirectPostBinding = resolveDirectBinding(state, {
  nativeId: binding.nativeId,
  generation: binding.generation
});

// @ts-expect-error direct-post bindings use the shared provider vocabulary
const invalidBinding: DirectPostBinding = { ...binding, provider: 'other' };

void result;
void incompleteFetchImpl;
void requestId;
void resolvedBinding;
void invalidBinding;
