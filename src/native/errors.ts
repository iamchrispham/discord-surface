import type { NativeError } from './contracts';

export function asNativeError(error: unknown): NativeError {
  if (error instanceof Error) return error as NativeError;
  const typed = Object.assign(new Error(String(error)), { cause: error }) as NativeError;
  if (error && typeof error === 'object' && typeof (error as { wrote?: unknown }).wrote === 'boolean') {
    typed.wrote = (error as { wrote: boolean }).wrote;
  }
  return typed;
}

export function errorCode(error: unknown): string | number | undefined {
  return error && typeof error === 'object' ? (error as { code?: string | number }).code : undefined;
}

