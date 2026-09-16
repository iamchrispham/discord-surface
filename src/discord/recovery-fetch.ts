const RETRYABLE_FETCH_PREFIX = 'Discord HTTP 503 during recovery: ';

export function isRetryableFetchBoundary(state: string, detail: string | null | undefined): boolean {
  return state === 'unavailable' && detail?.startsWith(RETRYABLE_FETCH_PREFIX) === true;
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
