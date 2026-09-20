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
import type { AgentAddressEnvelope, LegacyAgentAddressEnvelope } from '../src/agent-message';

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
  directPostRows: () => [],
  listReceipts: () => [],
  recoverDirectPostReceipts: () => undefined,
  inspectDirectPostPart: () => null,
  recordDirectPostPreflight: (_meta, outcome) => ({ outcome }),
  beginDirectPostPart: meta => ({ claimed: true, status: 'claimed', attemptId: meta.attemptId, nonce: meta.nonce }),
  directPostBindingCurrent: () => true,
  directPostOwnerIdentity: () => ({ ownerPid: 1, ownerStartTime: null, ownerCommand: null }),
  recordDirectPostOutcome: (_requestId, _attemptId, outcome) => ({ outcome, messageId: 'message' }),
  directPostFilePreparation: () => null,
  beginDirectPostFilePreparation: seed => seed as never,
  admitDirectPostFilePreparation: (_preparationId, manifest) => manifest as never
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
  version: 2,
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
  agentThreadId: 'thread',
  agentTarget,
  agentPresentation
};
// @ts-expect-error agent requests and results require an enrolled child route
const missingAgentThreadInput: DirectPostInput = { ...input, dedupeKey: 'missing-agent-thread', agentTarget };
// @ts-expect-error agent mode cannot be enabled without an enrolled child route
const missingAgentModeRouteInput: DirectPostInput = { ...input, dedupeKey: 'missing-agent-mode-route', agentMode: true };
// @ts-expect-error ordinary direct posts expose only the legacy presentation
const ordinaryAttachmentInput: DirectPostInput = { ...input, agentPresentation: AGENT_PRESENTATIONS.ATTACHMENT };
const legacyAgentTarget: LegacyAgentAddressEnvelope = { address: agentTarget.address, proof: agentTarget.proof };
const legacyRetryInput: DirectPostInput = {
  ...input,
  dedupeKey: 'legacy-retry',
  agentMode: true,
  agentThreadId: null,
  agentTarget: legacyAgentTarget
};
const legacyChildRetryInput: DirectPostInput = {
  ...input,
  dedupeKey: 'legacy-child-retry',
  agentMode: true,
  agentThreadId: 'thread',
  agentTarget: legacyAgentTarget
};
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
void missingAgentThreadInput;
void missingAgentModeRouteInput;
void ordinaryAttachmentInput;
void legacyRetryInput;
void legacyChildRetryInput;
void incompleteFetchImpl;
void requestId;
void resolvedBinding;
void invalidBinding;

const terminalLegacyResult: DirectPostInput = {
  ...input, dedupeKey: 'terminal-result', agentKind: 'result',
  agentReplyTo: 'legacy-request', agentThreadId: null, agentTarget: null
};
void terminalLegacyResult;
