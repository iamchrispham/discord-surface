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
  type FetchImplementation,
  type FetchOptions
} from '../src/direct-post';
import { AGENT_PRESENTATIONS, type AgentPresentation } from '../src/agent-presentation';
import type { AgentAddressEnvelope } from '../src/agent-message';

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
const multipartOptions: FetchOptions = {
  method: 'POST',
  headers: { 'Content-Type': 'multipart/form-data' },
  body: new FormData()
};
const agentPresentation: AgentPresentation = AGENT_PRESENTATIONS.ATTACHMENT;
const agentTarget: AgentAddressEnvelope = {
  address: {
    guildId: binding.guildId,
    channelId: 'target-channel',
    provider: 'claude',
    nativeId: '7b7d7b2b-0a61-43d0-b7f2-842f6d7fe2d1',
    generation: 1
  },
  proof: 'proof'
};
const agentInput: DirectPostInput = {
  ...input,
  dedupeKey: 'agent-request',
  agentTarget,
  agentPresentation
};
// @ts-expect-error ordinary direct posts expose only the legacy presentation
const ordinaryAttachmentInput: DirectPostInput = { ...input, agentPresentation: AGENT_PRESENTATIONS.ATTACHMENT };
const dedupeKey: string | undefined = resolveDedupeKey({ dedupeKey: 'request' });
const requestId: string = requestIdFor(binding, 'operator', sourcePath, 'hash', dedupeKey);
const resolvedBinding: DirectPostBinding = resolveDirectBinding(state, {
  nativeId: binding.nativeId,
  generation: binding.generation
});

// @ts-expect-error direct-post bindings use the shared provider vocabulary
const invalidBinding: DirectPostBinding = { ...binding, provider: 'other' };

void result;
void multipartOptions;
void agentInput;
void ordinaryAttachmentInput;
void incompleteFetchImpl;
void requestId;
void resolvedBinding;
void invalidBinding;
