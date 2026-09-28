import {
  isPreAdoptionRetryableThread,
  isRetryableFetchBoundary,
  recoveryFetch
} from '../../src/discord/recovery-fetch';

const retryable: boolean = isRetryableFetchBoundary('unavailable', 'Discord HTTP 503 during recovery: retry');
const notRetryable: boolean = isRetryableFetchBoundary('ready', null);
const preAdoption: boolean = isPreAdoptionRetryableThread(null);
const numberResult: Promise<number> = recoveryFetch(async () => 42);
const stringResult: Promise<string> = recoveryFetch(() => Promise.resolve('ready'));

void retryable;
void notRetryable;
void preAdoption;
void numberResult;
void stringResult;

// @ts-expect-error recoveryFetch preserves the callback result type
const wrongResult: Promise<number> = recoveryFetch(async () => 'ready');
void wrongResult;
