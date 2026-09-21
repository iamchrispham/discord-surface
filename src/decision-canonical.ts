import {
  CANONICAL_OPERATIONS,
  CanonicalOperation,
  CANONICAL_RUN_STATUSES,
  CanonicalRunStatus,
  CANONICAL_ERROR_CODES,
  CanonicalErrorCode,
  CANONICAL_PATH_KEYS,
  CanonicalPathKey,
  CanonicalPaths,
  CanonicalReplayRecipe,
  CanonicalRoute,
  CanonicalRouteOptions,
  CanonicalMenuItem,
  CanonicalMenu,
  CanonicalRegisterInput,
  CanonicalSettleInput,
  CanonicalReadInput,
  CanonicalCliPayload,
  CanonicalProcessError,
  CanonicalOperationResult,
  CanonicalRouteError,
  CanonicalOperationInput,
  ProcessExecution,
  ResolverPayload
} from './decision-canonical/contracts';
export {
  CANONICAL_OPERATIONS,
  CanonicalOperation,
  CANONICAL_RUN_STATUSES,
  CanonicalRunStatus,
  CANONICAL_ERROR_CODES,
  CanonicalErrorCode,
  CanonicalPaths,
  CanonicalReplayRecipe,
  CanonicalRoute,
  CanonicalRouteOptions,
  CanonicalMenuItem,
  CanonicalMenu,
  CanonicalRegisterInput,
  CanonicalSettleInput,
  CanonicalReadInput,
  CanonicalCliPayload,
  CanonicalProcessError,
  CanonicalOperationResult,
  CanonicalRouteError
} from './decision-canonical/contracts';
import { executeFile, processError } from './decision-canonical/process';
import * as os from 'node:os';
import * as path from 'node:path';

const RESOLVER_SENTINEL = 'resolve-canonical-paths';
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function defaultCanonicalCli(): string {
  return path.join(
    os.homedir(),
    '.claude',
    'skills',
    'phone-notify',
    'scripts',
    'tg-canonical.mjs',
  );
}

const RESOLVER_SCRIPT = `
import { pathToFileURL } from 'node:url';

const [, executable, stateRootArg, environmentJson] = process.argv.slice(1);
const environment = JSON.parse(environmentJson);
const owner = await import(pathToFileURL(executable).href);
const flags = stateRootArg ? { 'state-root': stateRootArg } : {};
const stateRoot = owner.resolveStateRoot(flags, environment);
const paths = owner.canonicalPathsFor(stateRoot, environment);
process.stdout.write(JSON.stringify({
  stateRoot: stateRoot || null,
  paths: {
    root: paths.root,
    stateDir: paths.stateDir,
    questionDir: paths.questionDir,
    answerDir: paths.answerDir,
    answeredDir: paths.answeredDir,
    claimsDir: paths.claimsDir,
    claimsDoneDir: paths.claimsDoneDir,
    acceptsFile: paths.acceptsFile,
    disarmFile: paths.disarmFile,
  },
}));
`;

function copyEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }

  return environment;
}

function ownerEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const key of ['HOME', 'TELEGRAM_ROOT', 'TG_CANONICAL_STATE_ROOT']) {
    const value = environment[key];
    if (typeof value === 'string') {
      selected[key] = value;
    }
  }

  return selected;
}

function normalizedPaths(raw: unknown): CanonicalPaths {
  if (!raw || typeof raw !== 'object') {
    throw new CanonicalRouteError('canonical owner returned no paths');
  }

  const candidate = raw as Record<string, unknown>;
  const paths = {} as Record<CanonicalPathKey, string>;

  for (const key of CANONICAL_PATH_KEYS) {
    const value = candidate[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new CanonicalRouteError(`canonical owner returned invalid path: ${key}`);
    }
    paths[key] = path.resolve(value);
  }

  return paths as CanonicalPaths;
}

function parseResolverPayload(stdout: string): ResolverPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new CanonicalRouteError(
      `canonical path resolver returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new CanonicalRouteError('canonical path resolver returned invalid data');
  }

  return { paths: normalizedPaths((parsed as Record<string, unknown>).paths) };
}

async function resolveOwnerPaths(
  executable: string,
  stateRoot: string | undefined,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
): Promise<CanonicalPaths> {
  const execution = await executeFile(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      RESOLVER_SCRIPT,
      RESOLVER_SENTINEL,
      executable,
      stateRoot ?? '',
      JSON.stringify(ownerEnvironment(environment)),
    ],
    environment,
    signal,
    maxOutputBytes,
  );

  if (
    execution.signal ||
    execution.error?.code === CANONICAL_ERROR_CODES.CANCELLED
  ) {
    throw new CanonicalRouteError('canonical path resolver was cancelled');
  }
  if (execution.exitCode !== 0) {
    throw new CanonicalRouteError(
      `canonical path resolver failed: ${execution.error?.message ?? (execution.stderr.trim() || 'unknown error')}`,
    );
  }

  return parseResolverPayload(execution.stdout).paths;
}

function samePaths(left: CanonicalPaths, right: CanonicalPaths): boolean {
  return CANONICAL_PATH_KEYS.every((key) => left[key] === right[key]);
}

function replayEnvironment(
  environment: NodeJS.ProcessEnv,
  telegramRoot: string,
): NodeJS.ProcessEnv {
  const replay = copyEnvironment(environment);
  replay.TELEGRAM_ROOT = telegramRoot;
  delete replay.TG_CANONICAL_STATE_ROOT;
  return replay;
}

function unknownResult(
  operation: CanonicalOperation,
  error: CanonicalProcessError,
  execution?: Partial<ProcessExecution>,
): CanonicalOperationResult {
  return {
    operation,
    status: CANONICAL_RUN_STATUSES.UNKNOWN,
    payload: null,
    stdout: execution?.stdout ?? '',
    stderr: execution?.stderr ?? '',
    exitCode: execution?.exitCode ?? null,
    signal: execution?.signal ?? null,
    error,
  };
}

function operationArguments(
  operation: CanonicalOperation,
  input: CanonicalOperationInput,
): string[] {
  switch (operation) {
    case CANONICAL_OPERATIONS.REGISTER: {
      const register = input as CanonicalRegisterInput;
      const menu = typeof register.menu === 'string'
        ? register.menu
        : JSON.stringify(register.menu);
      const args = [
        operation,
        '--namespace',
        register.namespace,
        '--request-id',
        register.requestId,
        '--target',
        register.target,
        '--head',
        register.head ?? '-',
        '--question',
        register.question,
        '--menu',
        menu,
      ];
      if (register.ttlHours !== undefined) {
        args.push('--ttl', String(register.ttlHours));
      }
      if (register.noResearch) {
        args.push('--no-research');
      }
      return args;
    }
    case CANONICAL_OPERATIONS.SETTLE: {
      const settle = input as CanonicalSettleInput;
      return [
        operation,
        '--qid',
        settle.qid,
        '--generation',
        settle.generation,
        '--target',
        settle.target,
        '--selected',
        settle.selected,
        '--provenance',
        settle.provenance,
      ];
    }
    case CANONICAL_OPERATIONS.READ: {
      const read = input as CanonicalReadInput;
      return [
        operation,
        '--qid',
        read.qid,
        '--generation',
        read.generation,
      ];
    }
  }

  throw new CanonicalRouteError(`unsupported canonical operation: ${operation}`);
}

function parsedPayload(stdout: string): CanonicalCliPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  return parsed as CanonicalCliPayload;
}

function operationResult(
  operation: CanonicalOperation,
  execution: ProcessExecution,
): CanonicalOperationResult {
  if (
    execution.signal ||
    execution.error?.code === CANONICAL_ERROR_CODES.CANCELLED ||
    execution.error?.code === CANONICAL_ERROR_CODES.OUTPUT_OVERFLOW ||
    execution.exitCode === null
  ) {
    return unknownResult(operation, execution.error ?? {
      code: execution.signal ?? CANONICAL_ERROR_CODES.UNKNOWN_CHILD,
      message: 'canonical child outcome is unknown',
    }, execution);
  }

  const payload = parsedPayload(execution.stdout);
  if (!payload || typeof payload.ok !== 'boolean') {
    return unknownResult(operation, {
      code: CANONICAL_ERROR_CODES.INVALID_OUTPUT,
      message: 'canonical child returned no complete JSON result',
    }, execution);
  }

  if (payload.ok === true && payload.operation !== operation) {
    return unknownResult(operation, {
      code: CANONICAL_ERROR_CODES.OPERATION_MISMATCH,
      message: 'canonical child returned a different operation',
    }, execution);
  }

  const complete = execution.exitCode === 0 || payload.ok === false;
  if (!complete) {
    return unknownResult(operation, execution.error ?? {
      code: execution.exitCode,
      message: 'canonical child failed without an explicit canonical result',
    }, execution);
  }

  return {
    operation,
    status: CANONICAL_RUN_STATUSES.COMPLETE,
    payload,
    stdout: execution.stdout,
    stderr: execution.stderr,
    exitCode: execution.exitCode,
    signal: execution.signal,
    error: processError(execution.error),
  };
}

export async function resolveCanonicalRoute(
  options: CanonicalRouteOptions = {},
): Promise<CanonicalRoute> {
  const executable = path.resolve(options.executable ?? defaultCanonicalCli());
  const environment = copyEnvironment(options.environment);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const initialPaths = await resolveOwnerPaths(
    executable,
    options.stateRoot,
    environment,
    options.signal,
    maxOutputBytes,
  );
  const replayStateRoot = path.dirname(initialPaths.stateDir);
  const replayTelegramRoot = initialPaths.root;
  const checkedEnvironment = replayEnvironment(environment, replayTelegramRoot);
  const checkedPaths = await resolveOwnerPaths(
    executable,
    replayStateRoot,
    checkedEnvironment,
    options.signal,
    maxOutputBytes,
  );

  if (!samePaths(initialPaths, checkedPaths)) {
    throw new CanonicalRouteError(
      'canonical route changed while deriving replay locations',
      CANONICAL_ERROR_CODES.ROUTE_DRIFT,
    );
  }

  return {
    executable,
    paths: initialPaths,
    replay: {
      executable,
      stateRoot: replayStateRoot,
      telegramRoot: replayTelegramRoot,
      args: ['--state-root', replayStateRoot],
      environment: { TELEGRAM_ROOT: replayTelegramRoot },
    },
  };
}

async function verifyReplay(
  route: CanonicalRoute,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
): Promise<void> {
  const replay = replayEnvironment(environment, route.replay.telegramRoot);
  const paths = await resolveOwnerPaths(
    route.replay.executable,
    route.replay.stateRoot,
    replay,
    signal,
    maxOutputBytes,
  );

  if (!samePaths(route.paths, paths)) {
    throw new CanonicalRouteError(
      'canonical replay locations no longer match the selected route',
      CANONICAL_ERROR_CODES.ROUTE_DRIFT,
    );
  }
}

async function runCanonicalOperationImpl(
  route: CanonicalRoute,
  operation: CanonicalOperation,
  input: CanonicalOperationInput,
  options: CanonicalRouteOptions = {},
): Promise<CanonicalOperationResult> {
  if (options.signal?.aborted) {
    return unknownResult(operation, {
      code: CANONICAL_ERROR_CODES.CANCELLED,
      message: 'canonical operation was cancelled before execution',
    });
  }

  const environment = copyEnvironment(options.environment);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  try {
    await verifyReplay(route, environment, options.signal, maxOutputBytes);
  } catch (error) {
    if (options.signal?.aborted || error instanceof CanonicalRouteError && error.message.includes('cancelled')) {
      return unknownResult(operation, {
        code: CANONICAL_ERROR_CODES.CANCELLED,
        message: 'canonical operation was cancelled while checking its route',
      });
    }
    throw error;
  }

  const replay = replayEnvironment(environment, route.replay.telegramRoot);
  const execution = await executeFile(
    process.execPath,
    [
      route.replay.executable,
      ...operationArguments(operation, input),
      ...route.replay.args,
    ],
    replay,
    options.signal,
    maxOutputBytes,
  );
  return operationResult(operation, execution);
}

export function runCanonicalOperation(
  route: CanonicalRoute,
  operation: typeof CANONICAL_OPERATIONS.REGISTER,
  input: CanonicalRegisterInput,
  options?: CanonicalRouteOptions,
): Promise<CanonicalOperationResult>;
export function runCanonicalOperation(
  route: CanonicalRoute,
  operation: typeof CANONICAL_OPERATIONS.SETTLE,
  input: CanonicalSettleInput,
  options?: CanonicalRouteOptions,
): Promise<CanonicalOperationResult>;
export function runCanonicalOperation(
  route: CanonicalRoute,
  operation: typeof CANONICAL_OPERATIONS.READ,
  input: CanonicalReadInput,
  options?: CanonicalRouteOptions,
): Promise<CanonicalOperationResult>;
export function runCanonicalOperation(
  route: CanonicalRoute,
  operation: CanonicalOperation,
  input: CanonicalOperationInput,
  options?: CanonicalRouteOptions,
): Promise<CanonicalOperationResult> {
  return runCanonicalOperationImpl(route, operation, input, options);
}
