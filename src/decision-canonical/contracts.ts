export const CANONICAL_OPERATIONS = Object.freeze({
  REGISTER: 'register',
  SETTLE: 'settle',
  READ: 'read',
} as const);

export type CanonicalOperation =
  (typeof CANONICAL_OPERATIONS)[keyof typeof CANONICAL_OPERATIONS];

export const CANONICAL_RUN_STATUSES = Object.freeze({
  COMPLETE: 'complete',
  UNKNOWN: 'unknown',
} as const);

export type CanonicalRunStatus =
  (typeof CANONICAL_RUN_STATUSES)[keyof typeof CANONICAL_RUN_STATUSES];

export const CANONICAL_ERROR_CODES = Object.freeze({
  ROUTE: 'CANONICAL_ROUTE_ERROR',
  ROUTE_DRIFT: 'CANONICAL_ROUTE_DRIFT',
  CANCELLED: 'ABORT_ERR',
  OUTPUT_OVERFLOW: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  INVALID_OUTPUT: 'CANONICAL_INVALID_OUTPUT',
  OPERATION_MISMATCH: 'CANONICAL_OPERATION_MISMATCH',
  UNKNOWN_CHILD: 'CANONICAL_CHILD_UNKNOWN',
} as const);

export type CanonicalErrorCode =
  (typeof CANONICAL_ERROR_CODES)[keyof typeof CANONICAL_ERROR_CODES];

export const CANONICAL_PATH_KEYS = [
  'root',
  'stateDir',
  'questionDir',
  'answerDir',
  'answeredDir',
  'claimsDir',
  'claimsDoneDir',
  'acceptsFile',
  'disarmFile',
] as const;

export type CanonicalPathKey = (typeof CANONICAL_PATH_KEYS)[number];

export interface CanonicalPaths {
  readonly root: string;
  readonly stateDir: string;
  readonly questionDir: string;
  readonly answerDir: string;
  readonly answeredDir: string;
  readonly claimsDir: string;
  readonly claimsDoneDir: string;
  readonly acceptsFile: string;
  readonly disarmFile: string;
}

export interface CanonicalReplayRecipe {
  readonly executable: string;
  readonly stateRoot: string;
  readonly telegramRoot: string;
  readonly args: readonly ['--state-root', string];
  readonly environment: Readonly<{ TELEGRAM_ROOT: string }>;
}

export interface CanonicalRoute {
  readonly executable: string;
  readonly paths: CanonicalPaths;
  readonly replay: CanonicalReplayRecipe;
}

export interface CanonicalRouteOptions {
  readonly executable?: string;
  readonly stateRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

export interface CanonicalMenuItem {
  readonly key: string;
  readonly consequence?: string;
}

export type CanonicalMenu =
  | string
  | readonly (string | CanonicalMenuItem)[];

export interface CanonicalRegisterInput {
  readonly namespace: string;
  readonly requestId: string;
  readonly target: string;
  readonly head?: string;
  readonly question: string;
  readonly menu: CanonicalMenu;
  readonly ttlHours?: string | number;
  readonly noResearch?: boolean;
}

export interface CanonicalSettleInput {
  readonly qid: string;
  readonly generation: string;
  readonly target: string;
  readonly selected: string;
  readonly provenance: string;
}

export interface CanonicalReadInput {
  readonly qid: string;
  readonly generation: string;
}

export interface CanonicalCliPayload {
  readonly ok?: boolean;
  readonly operation?: CanonicalOperation;
  readonly [key: string]: unknown;
}

export interface CanonicalProcessError {
  readonly code: string | number | null;
  readonly message: string;
}

export interface CanonicalOperationResult {
  readonly operation: CanonicalOperation;
  readonly status: CanonicalRunStatus;
  readonly payload: CanonicalCliPayload | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: CanonicalProcessError | null;
}

export class CanonicalRouteError extends Error {
  readonly code:
    | typeof CANONICAL_ERROR_CODES.ROUTE
    | typeof CANONICAL_ERROR_CODES.ROUTE_DRIFT;

  constructor(
    message: string,
    code:
      | typeof CANONICAL_ERROR_CODES.ROUTE
      | typeof CANONICAL_ERROR_CODES.ROUTE_DRIFT = CANONICAL_ERROR_CODES.ROUTE,
  ) {
    super(message);
    this.name = 'CanonicalRouteError';
    this.code = code;
  }
}

export type CanonicalOperationInput =
  | CanonicalRegisterInput
  | CanonicalSettleInput
  | CanonicalReadInput;

export interface ProcessExecution {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: CanonicalProcessError | null;
}

export interface ResolverPayload {
  readonly paths: Record<CanonicalPathKey, string>;
}
