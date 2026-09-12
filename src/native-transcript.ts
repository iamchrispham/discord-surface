import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { validateNativeId } = require('../src/state') as {
  validateNativeId: (value: unknown) => unknown;
};

export const CODEX_VALIDATION_KINDS = Object.freeze({
  UNSUPPORTED_ROOT: 'unsupported-root',
  STOPPED: 'stopped',
  DEADLINE: 'deadline'
} as const);

export const TRANSCRIPT_BLOCK_BYTES = 64 * 1024;
export const TRANSCRIPT_HEADER_MAX_BYTES = 1024 * 1024;
export const CLAUDE_METADATA_RECORD_MAX_BYTES = 1024 * 1024;

type RecoveryKind = typeof CODEX_VALIDATION_KINDS[keyof typeof CODEX_VALIDATION_KINDS];

export interface ValidationOptions {
  signal?: AbortSignal;
  deadline?: number;
}

type RawValidationOptions = ValidationOptions | AbortSignal | undefined;

export interface CodexSessionIdentity {
  file: string;
  sessionId: string;
  threadId: string;
  workspace: string | null;
}

export interface AmbiguousCodexSessionIdentity {
  ambiguous: true;
  files: string[];
}

type DiscoveredCodexSessionIdentity = CodexSessionIdentity | AmbiguousCodexSessionIdentity;

function sessionRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir();
  return path.join(environment.CODEX_HOME || path.join(home, '.codex'), 'sessions');
}

function walk(dir: string, result: string[] = [], depth = 0): string[] {
  if (depth > 5 || !fs.existsSync(dir)) return result;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, result, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
  }
  return result;
}

function normalizeValidationOptions(options: RawValidationOptions = {}): ValidationOptions {
  if (options && 'aborted' in options && typeof options.aborted === 'boolean' && typeof options.addEventListener === 'function') {
    return { signal: options as AbortSignal };
  }
  return (options || {}) as ValidationOptions;
}

function validationError(kind: RecoveryKind, message: string): Error & { recoveryKind: RecoveryKind } {
  const error = new Error(message) as Error & { recoveryKind: RecoveryKind };
  error.recoveryKind = kind;
  return error;
}

function assertValidationActive(rawOptions: RawValidationOptions = {}): void {
  const options = normalizeValidationOptions(rawOptions);
  if (options.signal?.aborted) {
    throw validationError(CODEX_VALIDATION_KINDS.STOPPED, 'Codex transcript validation was stopped');
  }
  if (options.deadline !== undefined && Date.now() >= options.deadline) {
    throw validationError(CODEX_VALIDATION_KINDS.DEADLINE, 'Codex transcript validation deadline exceeded');
  }
}

async function readSessionHeaderAsync(file: string, rawOptions: RawValidationOptions = {}): Promise<string> {
  const options = normalizeValidationOptions(rawOptions);
  let handle: fs.promises.FileHandle | null = null;
  let closePromise: Promise<void> | null = null;
  const closeHandle = (): Promise<void> => {
    if (!handle) return Promise.resolve();
    if (!closePromise) closePromise = handle.close().catch(() => undefined);
    return closePromise || Promise.resolve();
  };
  let onAbort: (() => void) | undefined;
  const abortPromise: Promise<never> | null = options.signal ? new Promise((_, reject) => {
    onAbort = () => {
      closeHandle();
      reject(validationError(CODEX_VALIDATION_KINDS.STOPPED, 'Codex transcript validation was stopped'));
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  }) : null;
  const guarded = <T>(operation: Promise<T>): Promise<T> => abortPromise
    ? Promise.race([operation, abortPromise]) as Promise<T>
    : operation;
  try {
    const opening = fs.promises.open(file, 'r');
    opening.then(candidate => {
      if (options.signal?.aborted) candidate.close().catch(() => undefined);
    }, () => undefined);
    handle = await guarded(opening);
    assertValidationActive(options);
    const { size } = await guarded<fs.Stats>(handle.stat());
    assertValidationActive(options);
    const parts: Buffer[] = [];
    let headerBytes = 0;
    for (let position = 0; position < size;) {
      assertValidationActive(options);
      const length = Math.min(TRANSCRIPT_BLOCK_BYTES, size - position);
      const bytes = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const result = await guarded<{ bytesRead: number }>(handle.read(bytes, read, length - read, position + read));
        assertValidationActive(options);
        if (!result.bytesRead) throw new Error('transcript shortened during read');
        read += result.bytesRead;
      }
      const newline = bytes.indexOf(0x0a);
      const part = newline < 0 ? bytes : bytes.subarray(0, newline);
      if (headerBytes + part.length > TRANSCRIPT_HEADER_MAX_BYTES) {
        throw new Error(`transcript header exceeds ${TRANSCRIPT_HEADER_MAX_BYTES} bytes`);
      }
      parts.push(part);
      headerBytes += part.length;
      if (newline >= 0) break;
      position += bytes.length;
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    if (options.signal && onAbort) options.signal.removeEventListener('abort', onAbort);
    const closing = closeHandle();
    if (!options.signal?.aborted) await closing;
  }
}

function awaitWithDeadline<T>(task: () => T | Promise<T>, deadline: number, onDeadline: (() => void) | null = null): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(validationError(CODEX_VALIDATION_KINDS.DEADLINE, 'operation deadline exceeded'));
  let timer: NodeJS.Timeout;
  const operation = Promise.resolve().then(task);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onDeadline?.(); } finally {
        reject(validationError(CODEX_VALIDATION_KINDS.DEADLINE, 'operation deadline exceeded'));
      }
    }, Math.min(remaining, 0x7fffffff));
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function openDirectoryWithDeadline(dir: string, deadline: number): Promise<fs.Dir> {
  const opening = Promise.resolve().then(() => fs.promises.opendir(dir));
  return awaitWithDeadline(() => opening, deadline).catch(error => {
    opening.then(async handle => {
      try { await handle.close(); } catch {}
    }, () => undefined);
    throw error;
  });
}

interface ScanOptions extends ValidationOptions {
  complete?: boolean;
}

async function closeDirectoryWithDeadline(handle: fs.Dir, options: ScanOptions | null): Promise<void> {
  const closing = Promise.resolve().then(() => handle.close());
  closing.catch(() => {
    if (options) options.complete = false;
  });
  try {
    if (options) await awaitWithDeadline(() => closing, options.deadline!);
    else await closing;
  } catch {
    if (options) options.complete = false;
  }
}

export async function* walkAsync(dir: string, depth = 0, rawOptions: RawValidationOptions = undefined): AsyncGenerator<string> {
  const scan: ScanOptions | null = rawOptions ? normalizeValidationOptions(rawOptions) : null;
  const limitReached = () => scan && scan.deadline !== undefined && Date.now() >= scan.deadline;
  if (scan) assertValidationActive(scan);
  if (depth > 5 || limitReached()) return;
  let handle: fs.Dir | undefined;
  try {
    handle = scan
      ? await openDirectoryWithDeadline(dir, scan.deadline!)
      : await fs.promises.opendir(dir);
    for (;;) {
      if (scan) assertValidationActive(scan);
      if (limitReached()) return;
      const entry = scan
        ? await awaitWithDeadline(() => handle!.read(), scan.deadline!)
        : await handle.read();
      if (!entry) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walkAsync(full, depth + 1, scan || undefined);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } catch (error) {
    if ((error as { recoveryKind?: RecoveryKind })?.recoveryKind) throw error;
    return;
  } finally {
    if (handle) await closeDirectoryWithDeadline(handle, scan);
  }
}

const CODEX_SESSION_DISCOVERY_TIMEOUT_MS = 5000;

export async function readCodexSessionIdentityAsync(
  nativeId: string,
  root = sessionRoot(),
  rawOptions: RawValidationOptions = {}
): Promise<DiscoveredCodexSessionIdentity | null> {
  validateNativeId(nativeId);
  const supplied = normalizeValidationOptions(rawOptions);
  const options = supplied.deadline === undefined
    ? { ...supplied, deadline: Date.now() + CODEX_SESSION_DISCOVERY_TIMEOUT_MS }
    : supplied;
  const matches: CodexSessionIdentity[] = [];
  let fileFailures = 0;
  for await (const file of walkAsync(root, 0, options)) {
    assertValidationActive(options);
    if (!file.includes(nativeId)) continue;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    options.signal?.addEventListener('abort', relayAbort, { once: true });
    try {
      const readOptions = Object.create(options) as ValidationOptions;
      Object.defineProperty(readOptions, 'signal', { value: controller.signal, enumerable: true });
      const row = JSON.parse(await awaitWithDeadline(
        () => readSessionHeaderAsync(file, readOptions),
        options.deadline!,
        () => controller.abort()
      )) as { type?: unknown; payload?: unknown };
      assertValidationActive(options);
      const payload = row?.type === 'session_meta' && row.payload && typeof row.payload === 'object'
        ? row.payload as Record<string, unknown>
        : null;
      const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null;
      const threadId = typeof payload?.id === 'string' ? payload.id : null;
      if (sessionId && threadId && sessionId !== threadId) continue;
      if ((sessionId || threadId) !== nativeId) continue;
      matches.push({
        file, sessionId: nativeId, threadId: nativeId,
        workspace: typeof payload?.cwd === 'string' ? payload.cwd : null
      });
      if (matches.length > 1) return { ambiguous: true, files: matches.map(match => match.file) };
    } catch (error) {
      if ((error as { recoveryKind?: RecoveryKind })?.recoveryKind) throw error;
      fileFailures += 1;
    } finally {
      options.signal?.removeEventListener('abort', relayAbort);
    }
  }
  assertValidationActive(options);
  if (fileFailures > 0) return null;
  if (matches.length === 0) return null;
  return matches[0];
}

export function readTranscriptBlock(fd: number, position: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, bytes, read, length - read, position + read);
    if (!count) throw new Error('transcript shortened during read');
    read += count;
  }
  return bytes;
}

function readSessionHeader(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const parts: Buffer[] = [];
    let headerBytes = 0;
    for (let position = 0; position < size;) {
      const bytes = readTranscriptBlock(fd, position, Math.min(TRANSCRIPT_BLOCK_BYTES, size - position));
      const newline = bytes.indexOf(0x0a);
      const part = newline < 0 ? bytes : bytes.subarray(0, newline);
      if (headerBytes + part.length > TRANSCRIPT_HEADER_MAX_BYTES) {
        throw new Error(`transcript header exceeds ${TRANSCRIPT_HEADER_MAX_BYTES} bytes`);
      }
      parts.push(part);
      headerBytes += part.length;
      if (newline >= 0) break;
      position += bytes.length;
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function findCodexSessionFile(nativeId: string, root = sessionRoot()): string | null {
  for (const file of walk(root)) {
    if (!file.includes(nativeId)) continue;
    try {
      const row = JSON.parse(readSessionHeader(file)) as { type?: unknown; payload?: unknown };
      if (row.type !== 'session_meta') continue;
      const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
      const threadId = typeof payload.id === 'string' ? payload.id : null;
      if (sessionId && threadId && sessionId !== threadId) continue;
      if ((sessionId || threadId) === nativeId) return file;
    } catch {}
  }
  return null;
}

export function readCodexSessionIdentity(nativeId: string, root = sessionRoot()): DiscoveredCodexSessionIdentity | null {
  validateNativeId(nativeId);
  const matches: CodexSessionIdentity[] = [];
  for (const file of walk(root)) {
    if (!file.includes(nativeId)) continue;
    try {
      const row = JSON.parse(readSessionHeader(file)) as { type?: unknown; payload?: unknown };
      const payload = row?.type === 'session_meta' && row.payload && typeof row.payload === 'object'
        ? row.payload as Record<string, unknown>
        : null;
      const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null;
      const threadId = typeof payload?.id === 'string' ? payload.id : null;
      if (sessionId && threadId && sessionId !== threadId) continue;
      if ((sessionId || threadId) !== nativeId) continue;
      matches.push({
        file, sessionId: nativeId, threadId: nativeId,
        workspace: typeof payload?.cwd === 'string' ? payload.cwd : null
      });
    } catch {}
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) return { ambiguous: true, files: matches.map(match => match.file) };
  return matches[0];
}

export function codexHomeForSessionRoot(root: string): string {
  if (!path.isAbsolute(root) || path.basename(root) !== 'sessions') {
    const error = new Error('Unsupported Codex session root: queue requires <CODEX_HOME>/sessions') as Error & { recoveryKind: RecoveryKind };
    error.recoveryKind = CODEX_VALIDATION_KINDS.UNSUPPORTED_ROOT;
    throw error;
  }
  return path.dirname(root);
}

function normalizeCodexSessionIdentity(identity: CodexSessionIdentity, nativeId: string): CodexSessionIdentity {
  const sessionId = identity.sessionId ?? null;
  const threadId = identity.threadId ?? null;
  if (sessionId !== null && threadId !== null && sessionId !== threadId) {
    throw new Error('Codex transcript identity does not match the supplied native UUID');
  }
  if ((sessionId ?? threadId) !== nativeId) {
    throw new Error('Codex transcript identity does not match the supplied native UUID');
  }
  return {
    ...identity,
    sessionId: sessionId ?? threadId,
    threadId: threadId ?? sessionId
  };
}

export function validateCodexSessionIdentity(nativeId: string, workspace: string | undefined, root = sessionRoot()): CodexSessionIdentity {
  validateNativeId(nativeId);
  if (workspace !== undefined && (typeof workspace !== 'string' || !path.isAbsolute(workspace))) throw new Error('Codex workspace must be absolute');
  codexHomeForSessionRoot(root);
  const identity = readCodexSessionIdentity(nativeId, root);
  if (!identity) throw new Error('Codex transcript identity is unavailable');
  if ('ambiguous' in identity) throw new Error('Codex transcript identity is ambiguous');
  const normalizedIdentity = normalizeCodexSessionIdentity(identity, nativeId);
  if (workspace !== undefined && normalizedIdentity.workspace !== workspace) throw new Error('Codex transcript workspace does not match the supplied workspace');
  return normalizedIdentity;
}

export async function validateCodexSessionIdentityAsync(
  nativeId: string,
  workspace: string | undefined,
  root = sessionRoot(),
  options: RawValidationOptions = {}
): Promise<CodexSessionIdentity> {
  validateNativeId(nativeId);
  if (workspace !== undefined && (typeof workspace !== 'string' || !path.isAbsolute(workspace))) throw new Error('Codex workspace must be absolute');
  codexHomeForSessionRoot(root);
  let identity: DiscoveredCodexSessionIdentity | null;
  try {
    identity = await readCodexSessionIdentityAsync(nativeId, root, options);
  } catch (error) {
    const recoveryKind = (error as { recoveryKind?: RecoveryKind })?.recoveryKind;
    if (recoveryKind === CODEX_VALIDATION_KINDS.STOPPED || recoveryKind === CODEX_VALIDATION_KINDS.DEADLINE) {
      const unavailable = new Error('Codex transcript identity is unavailable', { cause: error }) as Error & { recoveryKind: RecoveryKind };
      unavailable.recoveryKind = recoveryKind;
      throw unavailable;
    }
    throw error;
  }
  if (!identity) throw new Error('Codex transcript identity is unavailable');
  if ('ambiguous' in identity) throw new Error('Codex transcript identity is ambiguous');
  const normalizedIdentity = normalizeCodexSessionIdentity(identity, nativeId);
  if (workspace !== undefined && normalizedIdentity.workspace !== workspace) throw new Error('Codex transcript workspace does not match the supplied workspace');
  return normalizedIdentity;
}

export { sessionRoot, walk };
