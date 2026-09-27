import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AcknowledgmentWatchOptions, AcknowledgmentWatch } from './contracts';
import { ACK_OUTCOMES, MESSAGE_STATES, REPLY_READY_RECEIPTS } from './constants';
import {
  currentReplyReadyMessages,
  hasAcknowledgmentReceipt,
  isAcknowledgmentPending,
  isRecord,
  latestAcknowledgmentOutcome,
  latestAcknowledgmentOutcomes,
  latestReceiptId,
  parseReceiptDetail,
  pendingAcknowledgments,
  property,
  receiptRowsAfter,
  retryableUnknown
} from './receipts';
import { createAcknowledgmentDelivery } from './delivery';

export function watchAcknowledgments({ state, send, deliver = createAcknowledgmentDelivery({ state, send }), onAcknowledged = null,
  logger = () => {}, watchFactory = fs.watch, rearmMs = 1000 }: AcknowledgmentWatchOptions): AcknowledgmentWatch {
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let timerDueAt: number | null = null;
  let running: Promise<void> | null = null;
  let dirty = false;
  let receiptCursor: number | null = null;
  const retryAtByMessage = new Map<string, number>();
  const notified = new Set<string>();
  function notifyAcknowledged(messageId: string): void {
    if (!onAcknowledged || notified.has(messageId) || !hasAcknowledgmentReceipt(state, messageId)) return;
    notified.add(messageId);
    Promise.resolve().then(() => onAcknowledged(messageId))
      .then(() => {})
      .catch(error => logger(`native acknowledgment resume failed: ${String(property(error, 'message'))}`))
      .finally(() => {
        if (closed || !state.db) return;
        const detail = latestAcknowledgmentOutcome(state, messageId);
        if (isRecord(detail) && (detail.outcome !== ACK_OUTCOMES.UNKNOWN || detail.terminal)) notified.delete(messageId);
      });
  }

  function rememberRetryAt(messageId: string): void {
    const detail = latestAcknowledgmentOutcome(state, messageId);
    if (retryableUnknown(detail)) retryAtByMessage.set(messageId, detail.retryAt);
    else retryAtByMessage.delete(messageId);
  }

  function nextRetryAt(): number | null {
    let next: number | null = null;
    for (const retryAt of retryAtByMessage.values()) {
      if (next === null || retryAt < next) next = retryAt;
    }
    return next;
  }

  function initialPending(now: number): { ids: string[]; wakeOnly: Set<string> } {
    const watermark = latestReceiptId(state);
    const ids = pendingAcknowledgments(state, now, watermark);
    const wakeOnly = new Set<string>();
    for (const messageId of currentReplyReadyMessages(state, watermark)) {
      notified.delete(messageId);
      if (ids.includes(messageId)) continue;
      ids.push(messageId);
      wakeOnly.add(messageId);
    }
    for (const row of latestAcknowledgmentOutcomes(state)) {
      const detail = parseReceiptDetail(row.detail);
      if (retryableUnknown(detail)) retryAtByMessage.set(row.discord_id, detail.retryAt);
    }
    receiptCursor = watermark;
    return { ids, wakeOnly };
  }

  function incrementalPending(now: number): { ids: string[]; wakeOnly: Set<string> } {
    const watermark = latestReceiptId(state);
    const rows = receiptRowsAfter(state, receiptCursor as number, watermark);
    const ids = [];
    const wakeOnly = new Set<string>();
    const queued = new Set<string>();
    const seen = new Set();
    const ready = new Set<string>();
    for (const row of rows) {
      if (!row.discord_id) continue;
      if (row.kind === REPLY_READY_RECEIPTS.REPLY || row.kind === REPLY_READY_RECEIPTS.BEFORE_SUBMIT) {
        ready.add(row.discord_id);
      }
      if (!seen.has(row.discord_id)) {
        seen.add(row.discord_id);
        rememberRetryAt(row.discord_id);
        if (isAcknowledgmentPending(state, row.discord_id, now)) {
          ids.push(row.discord_id);
          queued.add(row.discord_id);
        }
      }
    }
    for (const messageId of ready) {
      if (state.getMessage(messageId)?.state !== MESSAGE_STATES.REPLY_READY) continue;
      notified.delete(messageId);
      if (queued.has(messageId)) continue;
      ids.push(messageId);
      wakeOnly.add(messageId);
      queued.add(messageId);
    }
    for (const [messageId, retryAt] of retryAtByMessage) {
      if (retryAt > now || seen.has(messageId)) continue;
      rememberRetryAt(messageId);
      if (isAcknowledgmentPending(state, messageId, now) && !queued.has(messageId)) {
        ids.push(messageId);
        queued.add(messageId);
      }
    }
    receiptCursor = watermark;
    return { ids, wakeOnly };
  }

  async function drain(): Promise<void> {
    if (closed) return;
    if (running) { dirty = true; return running; }
    running = (async () => {
      const now = Date.now();
      const pending = receiptCursor === null ? initialPending(now) : incrementalPending(now);
      for (const id of pending.ids) {
        if (closed) return;
        notifyAcknowledged(id);
        if (!pending.wakeOnly.has(id)) await deliver(id);
        const detail = latestAcknowledgmentOutcome(state, id);
        if (isRecord(detail) && (detail.outcome !== ACK_OUTCOMES.UNKNOWN || detail.terminal)) notified.delete(id);
        rememberRetryAt(id);
      }
    })().catch(error => logger(`native acknowledgment drain failed: ${error.message}`));
    try { await running; }
    finally {
      running = null;
      if (receiptCursor !== null && latestReceiptId(state) > receiptCursor) dirty = true;
      if (dirty) { dirty = false; schedule(); }
      else {
        const retryAt = nextRetryAt();
        if (retryAt !== null) schedule(Math.max(0, retryAt - Date.now()));
      }
    }
  }
  function schedule(delay = 50) {
    if (closed) return;
    const wait = Math.max(0, delay);
    const dueAt = Date.now() + wait;
    if (timer !== null && timerDueAt !== null && timerDueAt <= dueAt) return;
    if (timer !== null) clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(() => {
      timer = null;
      timerDueAt = null;
      drain();
    }, wait);
  }
  const basename = path.basename(state.dbPath);
  let watcher: fs.FSWatcher | null = null;
  let retry: NodeJS.Timeout | null = null;
  let retryDelay = rearmMs;
  function arm(): void {
    if (closed) return;
    try {
      let next: fs.FSWatcher;
      next = watchFactory(path.dirname(state.dbPath), (_event, name) => {
        if (watcher === next) retryDelay = rearmMs;
        if (!name || String(name).startsWith(basename)) schedule();
      });
      watcher = next;
      next.on('error', error => {
        if (watcher !== next) return;
        watcher = null;
        try { next.close(); } catch {}
        logger(`native acknowledgment watch failed: ${error.message}`);
        if (!closed && !retry) {
          retry = setTimeout(() => { retry = null; arm(); }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60000);
        }
      });
      schedule();
    } catch (error: unknown) {
      logger(`native acknowledgment watch failed: ${String(property(error, 'message'))}`);
      if (!closed && !retry) {
        schedule(retryDelay);
        retry = setTimeout(() => { retry = null; arm(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60000);
      }
    }
  }
  arm();
  schedule();
  return {
    drain,
    async stop() {
      closed = true;
      watcher?.close();
      watcher = null;
      if (retry) clearTimeout(retry);
      retry = null;
      if (timer) clearTimeout(timer);
      timer = null;
      timerDueAt = null;
      notified.clear();
      await running;
    }
  };
}
