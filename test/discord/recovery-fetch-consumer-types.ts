import {
  isPreAdoptionRetryableThread,
  isRetryableFetchBoundary,
  recoveryFetch
} from '../../src/discord/recovery-fetch';
import type { ThreadEnrollment } from '../../src/state/thread-enrollment';

type FetchBoundary = (state: string, detail: string | null | undefined) => boolean;
type PreAdoptionBoundary = (enrollment: ThreadEnrollment | null | undefined) => boolean;
type RecoveryFetch = <T>(fetch: () => Promise<T>) => Promise<T>;

const classifyFetchBoundary: FetchBoundary = isRetryableFetchBoundary;
const classifyPreAdoptionBoundary: PreAdoptionBoundary = isPreAdoptionRetryableThread;
const runRecoveryFetch: RecoveryFetch = recoveryFetch;

const retryable: boolean = classifyFetchBoundary('unavailable', 'Discord HTTP 503 during recovery: retry');
const preAdoption: boolean = classifyPreAdoptionBoundary(null);
const recoveredNumber: Promise<number> = runRecoveryFetch(async () => 42);
const recoveredText: Promise<string> = runRecoveryFetch(() => Promise.resolve('ready'));

void retryable;
void preAdoption;
void recoveredNumber;
void recoveredText;

// @ts-expect-error recoveryFetch preserves the callback result type
const wrongResult: Promise<number> = runRecoveryFetch(async () => 'ready');
void wrongResult;
