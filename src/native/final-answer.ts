const { splitReply } = require('../../src/state') as { splitReply: (text: string) => string[] };

export interface TranscriptPart {
  type?: unknown;
  text?: unknown;
}

export interface TranscriptItem {
  phase?: unknown;
  content?: TranscriptPart[] | null;
}

export interface TranscriptPayload {
  type?: unknown;
  item?: TranscriptItem | null;
  phase?: unknown;
  content?: TranscriptPart[] | null;
}

export interface TranscriptRow {
  type?: unknown;
  payload?: TranscriptPayload | null;
}

const CREATED_THREAD_DIRECTIVE = /^::created-thread\{(?:threadId|clientThreadId)="[^"\r\n]+"\}$/;

type CodeFence = { marker: '`' | '~'; length: number };

function readFenceStart(line: string): CodeFence | null {
  const match = /^ {0,3}([`~]{3,})([^\r\n]*)$/.exec(line);
  if (!match) return null;
  const run = match[1];
  const marker = run[0] as CodeFence['marker'];
  if (!run.split('').every(char => char === marker)) return null;
  if (marker === '`' && match[2].includes('`')) return null;
  return { marker, length: run.length };
}

function isFenceClose(line: string, fence: CodeFence): boolean {
  const match = /^ {0,3}([`~]{3,})[ \t]*$/.exec(line);
  if (!match) return false;
  const run = match[1];
  return run[0] === fence.marker && run.length >= fence.length && run.split('').every(char => char === fence.marker);
}

function stripCreatedThreadDirectivePart(text: string, initialFence: CodeFence | null, initialLineStart: boolean): { text: string; fence: CodeFence | null; lineStart: boolean } {
  let fence = initialFence;
  let lineStart = initialLineStart;
  const lines: string[] = [];
  const rawLines = text.split('\n');
  for (const [index, rawLine] of rawLines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (fence) {
      if (lineStart && isFenceClose(line, fence)) fence = null;
    } else {
      if (lineStart && CREATED_THREAD_DIRECTIVE.test(line)) {
        continue;
      }
      if (lineStart) fence = readFenceStart(line);
    }
    lines.push(rawLine);
    lineStart = index < rawLines.length - 1;
  }
  return { text: lines.join('\n'), fence, lineStart: text.endsWith('\n') };
}

export type FinalAnswer = { text: string; parts: string[] };

function sanitizeCreatedThreadDirective(text: string): FinalAnswer {
  const sanitized = stripCreatedThreadDirectivePart(text, null, true).text.trim();
  if (!sanitized) return { text: '', parts: [] };
  return { text: sanitized, parts: splitReply(sanitized) };
}

export function parseFinalAnswer(row: TranscriptRow, marker: string): FinalAnswer | null {
  const payload = row.payload;
  let item = null;
  let phase = null;
  if (row.type === 'event_msg' && payload?.type === 'item_completed') {
    item = payload.item;
    phase = item?.phase;
  } else if (row.type === 'response_item' && payload?.type === 'message') {
    item = payload;
    phase = payload.phase;
  }
  if (!item || phase !== 'final_answer') return null;
  const text = (item.content || [])
    .filter(part => part.type === 'Text' || part.type === 'output_text')
    .map(part => part.text)
    .filter((value): value is string => typeof value === 'string')
    .join('')
    .trim();
  if (!text || text.split(/\r?\n/, 1)[0].trim() !== marker) return null;
  const newline = text.indexOf('\n');
  if (newline < 0) return null;
  return sanitizeCreatedThreadDirective(text.slice(newline + 1));
}

export function finalText(row: TranscriptRow, marker: string): string | null {
  return parseFinalAnswer(row, marker)?.text ?? null;
}

