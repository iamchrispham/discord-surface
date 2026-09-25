export const BOARD_RECEIPT_KINDS = Object.freeze({
  DESIGNATION: 'board-designation',
  ATTEMPT: 'board-refresh-attempt',
  OUTCOME: 'board-refresh-outcome'
} as const);

export const BOARD_OUTCOMES = Object.freeze({
  IN_FLIGHT: 'in_flight',
  APPLIED: 'applied',
  NO_OP: 'no_op',
  NOT_SENT: 'not_sent',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN: 'unknown',
  STALE: 'stale'
} as const);

export type BoardOutcome = typeof BOARD_OUTCOMES[keyof typeof BOARD_OUTCOMES];
export type BoardTerminalOutcome = Exclude<BoardOutcome, typeof BOARD_OUTCOMES.IN_FLIGHT | typeof BOARD_OUTCOMES.UNKNOWN>;

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

interface BoardDatabase {
  prepare(sql: string): SqlStatement;
}

export interface BoardBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  generation: number;
  conductorId?: string | null;
  repoKey?: string | null;
  sessionRoot?: string | null;
}

export interface BoardConfig {
  guildId: string;
  operatorId?: string;
}

export interface BoardState {
  db: BoardDatabase;
  transaction<T>(operation: () => T): T;
  getBinding(channelId: string): BoardBinding | null;
  requireConfig(): BoardConfig;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
  directPostOwnerIdentity?(pid: number): unknown;
  directPostOwnerAlive?(pid: number, identity: unknown): boolean;
}

export interface BoardTarget {
  guildId: string;
  channelId: string;
  messageId: string;
}

export interface BoardProvenance {
  source: 'reply' | 'direct-post';
  messageId: string;
  channelId: string;
  guildId: string;
  sourceMessageId?: string;
  requestId?: string;
  attemptId?: string;
  generation?: number;
  provider?: string;
}

export interface BoardOwner {
  guildId: string;
  channelId: string;
  provider: string;
  nativeId: string;
  generation: number;
  conductorId: string | null;
  repoKey: string | null;
}

export interface BoardRefreshMeta {
  requestId: string;
  target: BoardTarget;
  content: string;
  payloadHash: string;
  preEditContent: string;
  binding: BoardBinding;
  targetAuthorId: string;
  provenance: BoardProvenance;
  ownerPid?: number;
  ownerIdentity?: unknown;
}

export interface BoardRefreshAttempt {
  journal: 'board-refresh-v1';
  board: 'compact-status-board';
  operation: 'message.patch';
  requestId: string;
  dedupeKey: string;
  attemptId: string;
  guildId: string;
  channelId: string;
  targetMessageId: string;
  provider: string;
  nativeId: string;
  generation: number;
  conductorId: string | null;
  repoKey: string | null;
  content: string;
  preEditContent: string;
  payloadHash: string;
  baseRevision: number;
  revision: number;
  targetAuthorId: string;
  provenance: BoardProvenance;
  originalOwner: BoardOwner;
  ownerPid?: number;
  ownerIdentity?: unknown;
  status: typeof BOARD_OUTCOMES.IN_FLIGHT;
  outcome: typeof BOARD_OUTCOMES.IN_FLIGHT;
}

export interface BoardRefreshRecord extends Omit<BoardRefreshAttempt, 'outcome' | 'status'> {
  outcome: BoardOutcome;
  status: BoardOutcome;
  historical?: boolean;
  recordedAt: string;
  operationEndedAt?: string | null;
  [key: string]: unknown;
}

export interface BoardRevisionSnapshot {
  target: BoardTarget;
  revision: number;
}

export interface BoardAdmission {
  status: 'admitted' | BoardOutcome;
  requestId: string;
  targetMessageId: string;
  revision?: number;
  attemptId?: string;
  attempt?: BoardRefreshAttempt;
  outcome?: BoardOutcome;
  historical?: boolean;
  duplicate?: boolean;
  noOp?: boolean;
  reason?: string;
}

export interface BoardRecoveryEvidence {
  evidenceScope: string;
  observedAt: string;
  readbackContent: string;
  soleWriter: boolean;
  singleAttempt: boolean;
  noHiddenRetry: boolean;
}

export interface ReceiptRow {
  id: number;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
