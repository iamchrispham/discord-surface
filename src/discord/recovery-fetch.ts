import { THREAD_STATES, type ThreadEnrollment } from '../state/thread-enrollment';

const RETRYABLE_FETCH_PREFIX = 'Discord HTTP 503 during recovery: ';
const LEGACY_DEADLINE_DETAIL_SUFFIX = ' recovery exceeded 30000ms';
const LEGACY_DEADLINE_DETAILS = {
  THREAD: 'Discord recovery deadline exceeded',
  HISTORY_ADMISSION: 'Discord recovery deadline exceeded while admitting history',
  HISTORY_BOUND: 'history recovery deadline 30000ms reached',
  CODEX_TRANSCRIPT: 'Codex transcript proof unavailable before event write: Discord recovery deadline exceeded',
  CLAUDE_ENDPOINT: 'Claude endpoint unavailable before event write: Discord recovery deadline exceeded',
  CODEX_NATIVE_PREFLIGHT: 'Codex native preflight deadline exceeded'
} as const;

export const RECOVERY_DEADLINE_MARKER_PREFIX = 'Discord recovery deadline: ';
export const RECOVERY_RETRY_PENDING_PREFIX = 'Discord recovery retry pending: ';

interface IntakeBoundaryLike {
  state?: string;
  detail?: string | null;
  gap_from?: string | null;
  gap_to?: string | null;
  recovered_through_id?: string | null;
}

interface RetryBoundaryLike {
  state?: string;
  detail?: string | null;
}

export function classifyRecoveryFailure(error: unknown): { state: 'unavailable'; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const recoveryKind = error && typeof error === 'object'
    ? (error as { recoveryKind?: unknown }).recoveryKind
    : undefined;
  return {
    state: 'unavailable',
    detail: recoveryKind === 'deadline' && !detail.startsWith(RECOVERY_DEADLINE_MARKER_PREFIX)
      ? `${RECOVERY_DEADLINE_MARKER_PREFIX}${detail}`
      : detail
  };
}

export function isRetryableFetchBoundary(state: string, detail: string | null | undefined): boolean {
  return state === 'unavailable' && (
    isRetryableHttp503Boundary(state, detail) ||
    detail?.startsWith(RECOVERY_DEADLINE_MARKER_PREFIX) === true
  );
}

export function isRetryableHttp503Boundary(state: string, detail: string | null | undefined): boolean {
  return state === 'unavailable' && detail?.startsWith(RETRYABLE_FETCH_PREFIX) === true;
}

function isLegacyDeadlineDetail(detail: string | null | undefined): boolean {
  return Object.values(LEGACY_DEADLINE_DETAILS).includes(detail as typeof LEGACY_DEADLINE_DETAILS[keyof typeof LEGACY_DEADLINE_DETAILS]) ||
    (typeof detail === 'string' && detail.length > LEGACY_DEADLINE_DETAIL_SUFFIX.length &&
      detail.endsWith(LEGACY_DEADLINE_DETAIL_SUFFIX));
}

function isBoundedLegacyDeadlineDetail(detail: string | null | undefined): boolean {
  return Object.values(LEGACY_DEADLINE_DETAILS).includes(detail as typeof LEGACY_DEADLINE_DETAILS[keyof typeof LEGACY_DEADLINE_DETAILS]);
}

function hasConfirmedLegacyCursor(boundary: IntakeBoundaryLike): boolean {
  return typeof boundary.recovered_through_id === 'string' && boundary.recovered_through_id.length > 0;
}

function hasLegacyCursorBounds(boundary: IntakeBoundaryLike): boolean {
  return typeof boundary.gap_from === 'string' && boundary.gap_from === boundary.recovered_through_id &&
    typeof boundary.gap_to === 'string' && boundary.gap_to.length > 0;
}

function hasLegacyBaselineGap(boundary: IntakeBoundaryLike): boolean {
  return boundary.recovered_through_id == null && boundary.gap_from == null && boundary.gap_to == null;
}

export function isRetryableIntakeBoundary(boundary: IntakeBoundaryLike | null | undefined): boolean {
  if (!boundary) return false;
  if (isRetryableFetchBoundary(boundary.state || '', boundary.detail)) return true;
  return boundary.state === 'gap' && isLegacyDeadlineDetail(boundary.detail) &&
    (hasLegacyBaselineGap(boundary) ||
      (hasConfirmedLegacyCursor(boundary) &&
        (boundary.gap_from == null && boundary.gap_to == null ||
          (isBoundedLegacyDeadlineDetail(boundary.detail) && hasLegacyCursorBounds(boundary)))));
}

export function retryPendingBoundaryDetail(reason: string, boundary: RetryBoundaryLike): string {
  if (typeof boundary.detail === 'string' && boundary.detail.startsWith(RECOVERY_RETRY_PENDING_PREFIX)) return boundary.detail;
  let source = 'HTTP 503';
  if (boundary.state === 'gap' && isLegacyDeadlineDetail(boundary.detail)) source = 'legacy recovery timeout';
  else if (boundary.detail?.startsWith(RECOVERY_DEADLINE_MARKER_PREFIX)) source = 'recovery deadline';
  return `${RECOVERY_RETRY_PENDING_PREFIX}${reason} after ${source}`;
}

export function isInterruptedRetryBoundary(boundary: RetryBoundaryLike | null | undefined): boolean {
  return boundary?.state === THREAD_STATES.PENDING &&
    boundary.detail?.startsWith(RECOVERY_RETRY_PENDING_PREFIX) === true;
}

export function isPreAdoptionRetryableThread(enrollment: ThreadEnrollment | null | undefined): boolean {
  return Boolean(enrollment?.active && !enrollment.adoptedAt &&
    (enrollment.state === THREAD_STATES.PENDING || enrollment.state === THREAD_STATES.UNAVAILABLE) &&
    (isRetryableFetchBoundary(THREAD_STATES.UNAVAILABLE, enrollment.detail) || isInterruptedRetryBoundary(enrollment)));
}

export async function recoveryFetch<T>(fetch: () => Promise<T>): Promise<T> {
  try {
    return await fetch();
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 503) {
      throw new Error(`${RETRYABLE_FETCH_PREFIX}${error instanceof Error ? error.message : 'Service Unavailable'}`, { cause: error });
    }
    throw error;
  }
}
