import { THREAD_STATES, type ThreadEnrollment } from '../state/thread-enrollment';

const RETRYABLE_FETCH_PREFIX = 'Discord HTTP 503 during recovery: ';

export function isRetryableFetchBoundary(state: string, detail: string | null | undefined): boolean {
  return state === 'unavailable' && detail?.startsWith(RETRYABLE_FETCH_PREFIX) === true;
}

export function isPreAdoptionRetryableThread(enrollment: ThreadEnrollment | null | undefined): boolean {
  return Boolean(enrollment?.active && !enrollment.adoptedAt && enrollment.state === THREAD_STATES.PENDING &&
    isRetryableFetchBoundary(THREAD_STATES.UNAVAILABLE, enrollment.detail));
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
