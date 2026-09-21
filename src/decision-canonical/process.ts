import { execFile } from 'node:child_process';
import type { CanonicalProcessError, ProcessExecution } from './contracts';

export function processError(error: unknown): CanonicalProcessError | null {
  if (!error) {
    return null;
  }

  const candidate = error as NodeJS.ErrnoException;
  const code = typeof candidate.code === 'string' || typeof candidate.code === 'number'
    ? candidate.code
    : null;
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

export function executeFile(
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
): Promise<ProcessExecution> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        [...args],
        {
          env: environment,
          encoding: 'utf8',
          maxBuffer: maxOutputBytes,
          signal,
        },
        (error, stdout, stderr) => {
          const candidate = error as (NodeJS.ErrnoException & {
            signal?: string | null;
          }) | null;
          const numericExitCode = candidate && typeof candidate.code === 'number'
            ? candidate.code
            : error
              ? null
              : 0;

          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            exitCode: numericExitCode,
            signal: candidate?.signal ?? null,
            error: processError(error),
          });
        },
      );
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        error: processError(error),
      });
    }
  });
}
