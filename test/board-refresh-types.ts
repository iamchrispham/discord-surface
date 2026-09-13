import {
  BOARD_OUTCOMES,
  BOARD_RECEIPT_KINDS,
  createBoardRefreshHandlers,
  type BoardBinding,
  type BoardOutcome,
  type BoardProvenance,
  type BoardRecoveryEvidence,
  type BoardRefreshMeta,
  type BoardState,
  type BoardTarget,
  type BoardTerminalOutcome
} from '../src/state/board-refresh';
import {
  BOARD_MESSAGE_LIMIT,
  fetchBoardInstallation,
  fetchBoardTarget,
  hashBoardText,
  patchBoardMessage,
  readBoardText,
  type BoardFetch,
  type BoardMessage
} from '../src/discord/board-refresh';
import {
  runBoardRefresh,
  type BoardRefreshResult
} from '../src/board-refresh';

const target: BoardTarget = {
  guildId: 'guild-1',
  channelId: 'channel-1',
  messageId: 'message-1'
};

const binding: BoardBinding = {
  active: true,
  channelId: target.channelId,
  guildId: target.guildId,
  provider: 'codex',
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  generation: 1,
  conductorId: 'conductor-1',
  repoKey: 'repo:discord-surface'
};

const provenance: BoardProvenance = {
  source: 'direct-post',
  messageId: target.messageId,
  channelId: target.channelId,
  guildId: target.guildId,
  requestId: 'post-1',
  attemptId: 'attempt-1',
  generation: binding.generation,
  provider: binding.provider
};

const meta: BoardRefreshMeta = {
  requestId: 'refresh-1',
  target,
  content: 'compact board',
  payloadHash: 'payload-hash',
  preEditContent: 'old board',
  binding,
  targetAuthorId: 'bot-1',
  provenance
};

const evidence: BoardRecoveryEvidence = {
  evidenceScope: 'controlled readback',
  observedAt: '2026-09-12T19:00:00.000Z',
  readbackContent: meta.content,
  soleWriter: true,
  singleAttempt: true,
  noHiddenRetry: true
};

const state = null as unknown as BoardState;
const handlers = createBoardRefreshHandlers();
const revision = handlers.captureBoardRevision(state, target);
const admission = handlers.beginBoardRefresh(state, meta, revision.revision);
const outcome: BoardOutcome = BOARD_OUTCOMES.UNKNOWN;
const terminal: BoardTerminalOutcome = BOARD_OUTCOMES.APPLIED;
const resultContract = null as unknown as BoardRefreshResult;
const resultStatus: BoardOutcome = resultContract.status;
const resultOutcome: BoardOutcome | undefined = resultContract.outcome;
const receiptKind: typeof BOARD_RECEIPT_KINDS.ATTEMPT = BOARD_RECEIPT_KINDS.ATTEMPT;
const reconciler = handlers.reconcileBoardRefresh;

const fetchImpl: BoardFetch = async (_url, init) => {
  const method: 'GET' | 'PATCH' = init.method;
  return {
    ok: true,
    status: 200,
    json: async () => ({})
  };
};

const boardMessage: BoardMessage = {
  id: target.messageId,
  guildId: target.guildId,
  channelId: target.channelId,
  authorId: 'bot-1',
  authorIsBot: true,
  content: meta.content
};
const readText: string = readBoardText(meta.content);
const textHash: string = hashBoardText(readText);
const boardLimit: number = BOARD_MESSAGE_LIMIT;
const installation: Promise<{ id: string }> = fetchBoardInstallation({ token: 'fixture-token', fetchImpl });
const fetchedTarget: Promise<BoardMessage> = fetchBoardTarget({
  token: 'fixture-token',
  channelId: target.channelId,
  messageId: target.messageId,
  fetchImpl
});
const patchedTarget: Promise<BoardMessage> = patchBoardMessage({
  token: 'fixture-token',
  channelId: target.channelId,
  messageId: target.messageId,
  content: meta.content,
  fetchImpl
});

const runtime = null as unknown as Parameters<typeof runBoardRefresh>[0]['state'];
const refresh: Promise<BoardRefreshResult> = runBoardRefresh({
  state: runtime,
  token: 'fixture-token',
  nativeId: binding.nativeId,
  generation: binding.generation,
  channelId: target.channelId,
  messageId: target.messageId,
  textFile: '/tmp/board.txt',
  dedupeKey: 'refresh-1',
  fetchImpl,
  resolveBinding: (_state, input) => {
    input.nativeId satisfies string;
    input.generation satisfies number;
    input.channelId satisfies string;
    return binding;
  }
});

// @ts-expect-error Board outcomes are closed and do not accept a fabricated transport label.
const invalidOutcome: BoardOutcome = 'sent';
// @ts-expect-error Board refresh results expose only registered outcomes.
const invalidResultStatus: BoardRefreshResult['status'] = 'sent';
// @ts-expect-error Board refresh results expose only registered outcomes.
const invalidResultOutcome: BoardRefreshResult['outcome'] = 'sent';
// @ts-expect-error A target must name the exact message that may be patched.
const incompleteTarget: BoardTarget = { guildId: 'guild-1', channelId: 'channel-1' };
const invalidFetch: BoardFetch = async (_url, init) => {
  // @ts-expect-error The board transport has no POST fallback.
  init.method = 'POST';
  return { ok: true, status: 200, json: async () => ({}) };
};

void admission;
void outcome;
void terminal;
void resultStatus;
void resultOutcome;
void receiptKind;
void reconciler;
void evidence;
void boardMessage;
void textHash;
void boardLimit;
void installation;
void fetchedTarget;
void patchedTarget;
void refresh;
void invalidOutcome;
void invalidResultStatus;
void invalidResultOutcome;
void incompleteTarget;
void invalidFetch;
