import * as fs from 'node:fs';
import * as path from 'node:path';

const {
  AuthorizationError,
  MESSAGE_STATES,
  NATIVE_ACK_RECEIPT,
  StaleGenerationError,
  validateNativeId
} = require('../src/state') as {
  AuthorizationError: typeof Error;
  MESSAGE_STATES: {
    ACCEPTED: 'accepted';
    DISPATCHING: 'dispatching';
    UNCERTAIN: 'uncertain';
    SUBMITTED: 'submitted';
    REPLY_READY: 'reply_ready';
    REPLYING: 'replying';
    REPLIED: 'replied';
    DISPATCH_FAILED: 'dispatch_failed';
    REPLY_FAILED: 'reply_failed';
    REPLY_UNKNOWN: 'reply_unknown';
    REJECTED: 'rejected';
  };
  NATIVE_ACK_RECEIPT: string;
  StaleGenerationError: typeof Error;
  validateNativeId: (value: unknown) => unknown;
};

export type NativeProvider = 'codex' | 'claude';
export type MessageState = typeof MESSAGE_STATES[keyof typeof MESSAGE_STATES];
export type AcknowledgmentOutcome = 'sent' | 'stale' | 'failed' | 'unknown';

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

interface AcknowledgmentDatabase {
  prepare(sql: string): SqlStatement;
}

export interface AcknowledgmentMessage {
  id: string;
  provider: NativeProvider;
  nativeId: string;
  generation: number;
  state: MessageState;
  channelId?: string;
  guildId?: string;
  channel?: unknown;
}

export interface AcknowledgmentBinding {
  current: boolean;
}

export interface AcknowledgmentState {
  db: AcknowledgmentDatabase;
  dbPath: string;
  transaction<T>(operation: () => T): T;
  getMessage(messageId: string): AcknowledgmentMessage | null | undefined;
  currentMessageBinding(message: AcknowledgmentMessage): AcknowledgmentBinding | null | undefined;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
}

export interface NativeAcknowledgmentInput {
  provider: NativeProvider;
  messageId: string;
  nativeId: string;
  generation: number;
}

export interface NativeAcknowledgmentResult {
  recorded: boolean;
  duplicate: boolean;
  messageId: string;
}

export interface AcknowledgmentWaitStopped {
  outcome: 'stopped';
}

export interface AcknowledgmentWatch {
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export type AcknowledgmentSend = (message: AcknowledgmentMessage, reaction: string) => Promise<unknown>;
export type AcknowledgmentDelivery = (messageId: string) => Promise<void> | null;

export interface AcknowledgmentWatchOptions {
  state: AcknowledgmentState;
  send: AcknowledgmentSend;
  deliver?: AcknowledgmentDelivery;
  onAcknowledged?: ((messageId: string) => unknown | Promise<unknown>) | null;
  logger?: (message: string) => void;
  watchFactory?: typeof fs.watch;
  rearmMs?: number;
}

export const ACK = Object.freeze({ RECEIVED: NATIVE_ACK_RECEIPT, OUTCOME: 'native-ack-reaction' } as const);
const ACK_OUTCOMES = Object.freeze({ SENT: 'sent', STALE: 'stale', FAILED: 'failed', UNKNOWN: 'unknown' } as const);
export const ACK_WAITING = Symbol('native-acknowledgment-waiting');
export const REACTION = Object.freeze({ SAVED: '📥', ACKNOWLEDGED: '👀' } as const);
const ACK_RETRY = Object.freeze({ BASE_MS: 250, MAX_MS: 60000, MAX_ATTEMPTS: 8 } as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function property(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  return (value as Record<string, unknown>)[key];
}

function parseReceiptDetail(detail: unknown): unknown {
  if (typeof detail !== 'string') return detail && typeof detail === 'object' ? detail : null;
  try { return JSON.parse(detail); } catch { return null; }
}

function latestAcknowledgmentOutcomes(state: AcknowledgmentState): Array<{ discord_id: string; detail: unknown }> {
  return state.db.prepare(`SELECT done.discord_id, done.detail FROM receipts done
    WHERE done.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts newer WHERE newer.discord_id=done.discord_id
      AND newer.kind=done.kind AND newer.id>done.id)`).all<{ discord_id: string; detail: unknown }>(ACK.OUTCOME);
}

function latestAcknowledgmentOutcome(state: AcknowledgmentState, messageId: string): unknown {
  const row = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
    .get<{ detail: unknown }>(messageId, ACK.OUTCOME);
  return row ? parseReceiptDetail(row.detail) : null;
}

function hasAcknowledgmentReceipt(state: AcknowledgmentState, messageId: string): boolean {
  return Boolean(state.db.prepare('SELECT 1 FROM receipts WHERE discord_id=? AND kind=? LIMIT 1')
    .get(messageId, ACK.RECEIVED));
}

function receiptRowsAfter(state: AcknowledgmentState, receiptId: number, throughId: number): Array<{ id: number; discord_id: string }> {
  return state.db.prepare(`SELECT id, discord_id FROM receipts
    WHERE id>? AND id<=? AND kind IN (?, ?) ORDER BY id`).all<{ id: number; discord_id: string }>(receiptId, throughId, ACK.RECEIVED, ACK.OUTCOME);
}

function latestReceiptId(state: AcknowledgmentState): number {
  const row = state.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM receipts').get<{ id: number }>();
  return Number(row?.id);
}

function retryableUnknown(detail: unknown): detail is Record<string, unknown> & { retryAt: number } {
  return isRecord(detail) && detail.outcome === ACK_OUTCOMES.UNKNOWN && !detail.terminal && Number.isFinite(detail.retryAt);
}

function acknowledgmentCommand(message: AcknowledgmentMessage, dbPath: string, cliPath = path.join(__dirname, 'cli.js')): string[] {
  return [process.execPath, cliPath, 'native-ack', '--db', dbPath,
    '--provider', message.provider, '--message-id', message.id,
    '--native-id', message.nativeId, '--generation', String(message.generation)];
}

function recordNativeAcknowledgment(
  state: AcknowledgmentState,
  { provider, messageId, nativeId, generation }: NativeAcknowledgmentInput
): NativeAcknowledgmentResult {
  validateNativeId(nativeId);
  if (!['codex', 'claude'].includes(provider) || !Number.isInteger(generation) || generation < 1) {
    throw new Error('invalid native acknowledgment identity');
  }
  return state.transaction(() => {
    const message = state.getMessage(messageId);
    const current = message && state.currentMessageBinding(message);
    if (!message || !current?.current || message.provider !== provider || message.nativeId !== nativeId || message.generation !== generation) {
      throw new Error('native acknowledgment owner or generation is stale');
    }
    const duplicate = state.db.prepare('SELECT id FROM receipts WHERE discord_id=? AND kind=? LIMIT 1').get(messageId, ACK.RECEIVED);
    if (duplicate) return { recorded: false, duplicate: true, messageId };
    if (!([MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY,
      MESSAGE_STATES.REPLYING, MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN,
      MESSAGE_STATES.REPLIED, MESSAGE_STATES.UNCERTAIN] as readonly MessageState[]).includes(message.state)) {
      throw new Error(`native acknowledgment is not accepted in state ${message.state}`);
    }
    state.receipt(messageId, ACK.RECEIVED, { provider, nativeId, generation, source: 'explicit-native-ack' });
    if (([MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.UNCERTAIN] as readonly MessageState[]).includes(message.state)) {
      state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.SUBMITTED, new Date().toISOString(), messageId, message.state);
      state.receipt(messageId, 'dispatch-already-acknowledged', {
        generation,
        fromState: message.state
      });
    }
    return { recorded: true, duplicate: false, messageId };
  });
}

function pendingAcknowledgments(state: AcknowledgmentState, now = Date.now(), throughId: number | null = null): string[] {
  const outcomes = new Map(latestAcknowledgmentOutcomes(state).map(row => [row.discord_id, parseReceiptDetail(row.detail)]));
  const seen = new Set();
  const cutoff = throughId === null ? '' : ' AND r.id<=?';
  const statement = state.db.prepare(`SELECT r.discord_id FROM receipts r
    WHERE r.kind=? AND NOT EXISTS
    (SELECT 1 FROM receipts done WHERE done.discord_id=r.discord_id AND done.kind=?
      AND done.detail NOT LIKE ?)
    ${cutoff} ORDER BY r.id`);
  const rows = throughId === null
    ? statement.all<{ discord_id: string }>(ACK.RECEIVED, ACK.OUTCOME, '%"outcome":"unknown"%')
    : statement.all<{ discord_id: string }>(ACK.RECEIVED, ACK.OUTCOME, '%"outcome":"unknown"%', throughId);
  return rows
    .filter(row => {
      if (seen.has(row.discord_id)) return false;
      seen.add(row.discord_id);
      const detail = outcomes.get(row.discord_id);
      if (!detail) return true;
      if (!isRecord(detail) || detail.outcome !== ACK_OUTCOMES.UNKNOWN) return false;
      if (detail.terminal) return false;
      return !Number.isFinite(detail.retryAt) || Number(detail.retryAt) <= now;
    }).map(row => row.discord_id);
}

function isAcknowledgmentPending(state: AcknowledgmentState, messageId: string, now = Date.now()): boolean {
  const row = state.db.prepare(`SELECT r.discord_id, latest.detail AS outcome_detail
    FROM receipts r
    LEFT JOIN receipts latest ON latest.id = (
      SELECT candidate.id FROM receipts candidate
      WHERE candidate.discord_id=r.discord_id AND candidate.kind=?
      ORDER BY candidate.id DESC LIMIT 1
    )
    WHERE r.kind=? AND r.discord_id=?
    ORDER BY r.id DESC LIMIT 1`).get<{ outcome_detail: unknown }>(ACK.OUTCOME, ACK.RECEIVED, messageId);
  if (!row) return false;
  if (row.outcome_detail === null || row.outcome_detail === undefined) return true;
  const detail = parseReceiptDetail(row.outcome_detail);
  if (!isRecord(detail) || detail.outcome !== ACK_OUTCOMES.UNKNOWN) return false;
  if (detail.terminal) return false;
  return !Number.isFinite(detail.retryAt) || Number(detail.retryAt) <= now;
}

function unknownAcknowledgmentAttempts(state: AcknowledgmentState, messageId: string): number {
  return state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id')
    .all<{ detail: unknown }>(messageId, ACK.OUTCOME)
    .reduce((count, row) => {
      const detail = parseReceiptDetail(row.detail);
      return count + (isRecord(detail) && detail.outcome === ACK_OUTCOMES.UNKNOWN ? 1 : 0);
    }, 0);
}

function acknowledgmentFailureStatus(error: unknown): number | null {
  const response = property(error, 'response');
  const candidates = [property(error, 'status'), property(error, 'statusCode'), property(response, 'status'), property(error, 'code')];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const match = String(property(error, 'message') || error || '').match(/\b(4\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function acknowledgedMessage(state: AcknowledgmentState, messageId: string): AcknowledgmentMessage {
  const receipt = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
    .get<{ detail: unknown }>(messageId, ACK.RECEIVED);
  const identity = parseReceiptDetail(receipt?.detail);
  const message = state.getMessage(messageId);
  if (!message || !isRecord(identity) || message.provider !== identity.provider || message.nativeId !== identity.nativeId ||
    message.generation !== identity.generation) throw new Error('native acknowledgment owner or generation is stale');
  return message;
}

function createAcknowledgmentDelivery({ state, send }: { state: AcknowledgmentState; send: AcknowledgmentSend }): AcknowledgmentDelivery {
  const inFlight = new Map<string, Promise<void>>();
  const outcome = (id: string, result: AcknowledgmentOutcome, detail: Record<string, unknown> = {}) => state.transaction(() => state.receipt(id, ACK.OUTCOME, { outcome: result, ...detail }));
  return function deliver(id: string): Promise<void> | null {
    if (inFlight.has(id)) return inFlight.get(id) || null;
    if (!isAcknowledgmentPending(state, id)) return null;
    const work = (async () => {
      let message;
      try { message = acknowledgedMessage(state, id); }
      catch { outcome(id, ACK_OUTCOMES.STALE); return; }
      try {
        await send(message, REACTION.ACKNOWLEDGED);
        outcome(id, ACK_OUTCOMES.SENT, { reaction: REACTION.ACKNOWLEDGED, targetMessageId: id });
      } catch (error: unknown) {
        if (error instanceof StaleGenerationError || error instanceof AuthorizationError) {
          outcome(id, ACK_OUTCOMES.STALE, { error: String(property(error, 'message') || error).slice(0, 200) });
          return;
        }
        const status = acknowledgmentFailureStatus(error);
        const detail: Record<string, unknown> = { error: String(property(error, 'message') || error).slice(0, 200) };
        if (status !== null) detail.status = status;
        if (status !== null && status >= 400 && status < 500 && status !== 429) {
          outcome(id, ACK_OUTCOMES.FAILED, detail);
          return;
        }
        const attempt = unknownAcknowledgmentAttempts(state, id) + 1;
        const retry = {
          ...detail,
          attempt,
        };
        if (attempt >= ACK_RETRY.MAX_ATTEMPTS) {
          outcome(id, ACK_OUTCOMES.UNKNOWN, { ...retry, terminal: true });
          return;
        }
        const retryAfterMs = status === 429 ? acknowledgmentRetryAfterMs(error) : null;
        const retryDelay = retryAfterMs === null
          ? Math.min(ACK_RETRY.BASE_MS * (2 ** (attempt - 1)), ACK_RETRY.MAX_MS)
          : retryAfterMs;
        outcome(id, ACK_OUTCOMES.UNKNOWN, {
          ...retry,
          ...(retryAfterMs === null ? {} : { retryAfterMs }),
          retryAt: Date.now() + retryDelay
        });
      }
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, work);
    return work;
  };
}

function waitForAcknowledgment(
  state: AcknowledgmentState,
  deliver: AcknowledgmentDelivery,
  messageId: string,
  signal?: AbortSignal
): typeof ACK_WAITING | null | Promise<unknown | typeof ACK_WAITING | null> {
  if (!hasAcknowledgmentReceipt(state, messageId)) return ACK_WAITING;
  const current = latestAcknowledgmentOutcome(state, messageId);
  if (isRecord(current) && (current.outcome !== ACK_OUTCOMES.UNKNOWN || current.terminal)) return null;
  return (async () => {
    while (true) {
      if (signal?.aborted) return { outcome: 'stopped' };
      const current = latestAcknowledgmentOutcome(state, messageId);
      if (isRecord(current) && (current.outcome !== ACK_OUTCOMES.UNKNOWN || current.terminal)) return null;
      const work = deliver(messageId);
      if (work) await work;
      const outcome = latestAcknowledgmentOutcome(state, messageId);
      if (isRecord(outcome) && (outcome.outcome !== ACK_OUTCOMES.UNKNOWN || outcome.terminal)) return null;
      if (!outcome || !retryableUnknown(outcome)) return outcome;
      const delay = Math.max(0, outcome.retryAt - Date.now());
      if (!delay) continue;
      await new Promise<void>(resolve => {
        let timer: NodeJS.Timeout;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        timer = setTimeout(finish, delay);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
  })();
}

function acknowledgmentRetryAfterMs(error: unknown): number | null {
  const milliseconds = Number(property(error, 'retryAfterMs'));
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.ceil(milliseconds);
  const seconds = Number(property(error, 'retry_after'));
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  return null;
}

function watchAcknowledgments({ state, send, deliver = createAcknowledgmentDelivery({ state, send }), onAcknowledged = null,
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

  function initialPending(now: number): string[] {
    const watermark = latestReceiptId(state);
    const ids = pendingAcknowledgments(state, now, watermark);
    for (const row of latestAcknowledgmentOutcomes(state)) {
      const detail = parseReceiptDetail(row.detail);
      if (retryableUnknown(detail)) retryAtByMessage.set(row.discord_id, detail.retryAt);
    }
    receiptCursor = watermark;
    return ids;
  }

  function incrementalPending(now: number): string[] {
    const watermark = latestReceiptId(state);
    const rows = receiptRowsAfter(state, receiptCursor as number, watermark);
    const ids = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row.discord_id || seen.has(row.discord_id)) continue;
      seen.add(row.discord_id);
      rememberRetryAt(row.discord_id);
      if (isAcknowledgmentPending(state, row.discord_id, now)) ids.push(row.discord_id);
    }
    for (const [messageId, retryAt] of retryAtByMessage) {
      if (retryAt > now || seen.has(messageId)) continue;
      rememberRetryAt(messageId);
      if (isAcknowledgmentPending(state, messageId, now)) ids.push(messageId);
    }
    receiptCursor = watermark;
    return ids;
  }

  async function drain(): Promise<void> {
    if (closed) return;
    if (running) { dirty = true; return running; }
    running = (async () => {
      const now = Date.now();
      const ids = receiptCursor === null ? initialPending(now) : incrementalPending(now);
      for (const id of ids) {
        if (closed) return;
        notifyAcknowledged(id);
        await deliver(id);
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

export {
  acknowledgmentCommand,
  createAcknowledgmentDelivery,
  isAcknowledgmentPending,
  pendingAcknowledgments,
  recordNativeAcknowledgment,
  waitForAcknowledgment,
  watchAcknowledgments
};
