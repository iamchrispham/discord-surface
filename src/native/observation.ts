import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorCode } from './errors';
import { parseFinalAnswer, type FinalAnswer } from './final-answer';
import { TRANSCRIPT_BLOCK_BYTES, readTranscriptBlock, findCodexSessionFile, sessionRoot } from '../native-transcript';
import type { NativeStateExports, NativeState, PersistedObserverCursor, ObserverCursor, ObserveCodexOptions, CodexObservation, WaitForReplyOptions, WaitForReplyResult } from './contracts';

const { MESSAGE_STATES } = require('../../src/state') as NativeStateExports;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => finish();
    timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function cursorTailBytes(cursor: PersistedObserverCursor | null | undefined): Buffer {
  if (typeof cursor?.tailBytes === 'string') {
    try { return Buffer.from(cursor.tailBytes, 'base64'); } catch {}
  }
  return typeof cursor?.tail === 'string' ? Buffer.from(cursor.tail, 'utf8') : Buffer.alloc(0);
}

function readTranscriptTail(fd: number, size: number): Buffer<ArrayBufferLike> {
  const parts: Buffer<ArrayBufferLike>[] = [];
  for (let end = size; end > 0;) {
    const start = Math.max(0, end - TRANSCRIPT_BLOCK_BYTES);
    const bytes = readTranscriptBlock(fd, start, end - start);
    const newline = bytes.lastIndexOf(0x0a);
    parts.push(bytes.subarray(newline + 1));
    if (newline >= 0) break;
    end = start;
  }
  // Copy the suffix; a tiny tail must not keep the last read buffer alive.
  return Buffer.concat(parts.reverse());
}

export async function observeCodexReply(
  nativeId: string,
  cursor: PersistedObserverCursor | null | undefined,
  {
    marker,
    timeoutMs = 120000,
    root = sessionRoot(),
    resolveRoot,
    pollMs = 250,
    signal,
    onCursor,
    continueUntilFinal = false,
    isCurrent
  }: ObserveCodexOptions = {}
): Promise<CodexObservation> {
  if (!marker) throw new Error('Codex observer requires a unique response marker');
  const startedAt = Date.now();
  let offset = Number(cursor?.offset || 0);
  let tailBytes = cursorTailBytes(cursor);
  let since = Number(cursor?.since || startedAt);
  const initialSince = since;
  const normalizeRoot = (value: string | null | undefined): string | null => typeof value === 'string' && value.length > 0 ? path.resolve(value) : null;
  const staticRoot = normalizeRoot(root);
  const currentRoot = () => {
    if (typeof resolveRoot !== 'function') return staticRoot;
    try { return normalizeRoot(resolveRoot()) || staticRoot; } catch { return staticRoot; }
  };
  let activeRoot = currentRoot();
  let file = cursor?.file || null;
  if (file && activeRoot) {
    const relative = path.relative(activeRoot, path.resolve(file));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      file = null;
      offset = 0;
      tailBytes = Buffer.alloc(0);
    }
  }
  if (!file) file = findCodexSessionFile(nativeId, activeRoot as string);
  const currentCursor = () => ({ file, offset, since, tail: tailBytes.toString('utf8'), tailBytes: tailBytes.toString('base64') });
  const stopped = () => signal?.aborted || (isCurrent && !isCurrent());
  while (continueUntilFinal || Date.now() - startedAt < timeoutMs) {
    if (stopped()) return { stopped: true, cursor: currentCursor() };
    const nextRoot = currentRoot();
    if (nextRoot !== activeRoot) {
      activeRoot = nextRoot;
      file = null;
      offset = 0;
      tailBytes = Buffer.alloc(0);
      since = initialSince;
    }
    if (!file) file = findCodexSessionFile(nativeId, activeRoot as string);
    if (file) {
      try {
        const fd = fs.openSync(file, 'r');
        let answer: FinalAnswer | null = null;
        try {
          const end = fs.fstatSync(fd).size;
          const truncated = end < offset;
          const nextSince = truncated ? startedAt : since;
          let position = truncated ? 0 : offset;
          const pending = truncated ? Buffer.alloc(0) : tailBytes;
          let parts = pending.length ? [pending] : [];
          // Hold only the unfinished record; still scan to snapshot EOF after a
          // match so the returned offset and trailing bytes keep their semantics.
          while (position < end) {
            if (stopped()) return { stopped: true, cursor: currentCursor() };
            const bytes = readTranscriptBlock(fd, position, Math.min(TRANSCRIPT_BLOCK_BYTES, end - position));
            position += bytes.length;
            let start = 0;
            for (let newline = bytes.indexOf(0x0a); newline >= 0; newline = bytes.indexOf(0x0a, start)) {
              if (!answer && (parts.length || newline > start)) {
                const piece = bytes.subarray(start, newline);
                const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
                try {
                  const row = JSON.parse(line.toString('utf8'));
                  if (!(Date.parse(row.timestamp || '') < nextSince)) answer = parseFinalAnswer(row, marker);
                } catch {}
              }
              parts = [];
              start = newline + 1;
            }
            // Own the suffix: do not retain a whole block via a small subarray.
            if (start < bytes.length) parts.push(Buffer.from(bytes.subarray(start)));
          }
          if (stopped()) return { stopped: true, cursor: currentCursor() };
          // Commit only a fully read snapshot. A failed read must not lose bytes.
          offset = end;
          tailBytes = parts.length === 1 ? parts[0] : Buffer.concat(parts);
          since = nextSince;
        } finally {
          fs.closeSync(fd);
        }
        if (answer !== null) return { text: answer.text, parts: answer.parts, cursor: currentCursor() };
        onCursor?.(currentCursor());
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          file = null;
          offset = 0;
          tailBytes = Buffer.alloc(0);
        }
        onCursor?.(currentCursor());
      }
    }
    await sleep(pollMs, signal);
  }
  return { stopped: Boolean(signal?.aborted), cursor: currentCursor() };
}

export function readInitialCursor(nativeId: string, root = sessionRoot()): ObserverCursor {
  const file = findCodexSessionFile(nativeId, root);
  if (!file) return { file: null, offset: 0, since: Date.now(), tail: '' };
  let offset = 0;
  let tailBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      tailBytes = readTranscriptTail(fd, size);
      offset = size;
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return { file, offset, since: Date.now(), tail: tailBytes.toString('utf8'), tailBytes: tailBytes.toString('base64') };
}

export async function waitForReply(state: NativeState, messageId: string, { timeoutMs = 120000, pollMs = 250, signal, continueUntilFinal = false, isCurrent }: WaitForReplyOptions = {}): Promise<WaitForReplyResult | null> {
  const startedAt = Date.now();
  while (continueUntilFinal || Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) return { stopped: true };
    const message = state.getMessage(messageId);
    if (!message) return null;
    if (message.state === MESSAGE_STATES.REPLY_READY || message.state === MESSAGE_STATES.REPLIED) return { text: message.replyText };
    if (message.state === MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST) return { stopped: true };
    if (isCurrent && !isCurrent()) return { stopped: true };
    if (message.state === MESSAGE_STATES.UNCERTAIN || message.state === MESSAGE_STATES.REPLY_UNKNOWN) return null;
    await sleep(pollMs, signal);
  }
  return null;
}

