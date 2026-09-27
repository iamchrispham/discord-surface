import type { AcknowledgmentState, AcknowledgmentSend, AcknowledgmentDelivery } from './contracts';
import {
  ACK,
  ACK_OUTCOMES,
  ACK_WAITING,
  AuthorizationError,
  REACTION,
  StaleGenerationError
} from './constants';
import type { AcknowledgmentOutcome } from './constants';
import {
  acknowledgedMessage,
  hasAcknowledgmentReceipt,
  isAcknowledgmentPending,
  isRecord,
  latestAcknowledgmentOutcome,
  property,
  retryableUnknown,
  unknownAcknowledgmentAttempts
} from './receipts';

const ACK_RETRY = Object.freeze({ BASE_MS: 250, MAX_MS: 60000, MAX_ATTEMPTS: 8 } as const);

export function acknowledgmentFailureStatus(error: unknown): number | null {
  const response = property(error, 'response');
  const candidates = [property(error, 'status'), property(error, 'statusCode'), property(response, 'status'), property(error, 'code')];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const match = String(property(error, 'message') || error || '').match(/\b(4\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export function createAcknowledgmentDelivery({ state, send }: { state: AcknowledgmentState; send: AcknowledgmentSend }): AcknowledgmentDelivery {
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
        const sent = await send(message, REACTION.ACKNOWLEDGED);
        const targetMessageId = property(sent, 'targetMessageId');
        outcome(id, ACK_OUTCOMES.SENT, {
          reaction: REACTION.ACKNOWLEDGED,
          targetMessageId: typeof targetMessageId === 'string' && targetMessageId.length > 0 ? targetMessageId : id
        });
      } catch (error: unknown) {
        const visibility = property(error, 'visibility');
        if (visibility === 'local' || property(error, 'outcome') === 'local_visibility_failure') {
          const targetMessageId = property(error, 'targetMessageId');
          outcome(id, ACK_OUTCOMES.FAILED, {
            error: String(property(error, 'message') || error).slice(0, 200),
            ...(typeof targetMessageId === 'string' ? { targetMessageId } : {}),
            visibility: 'local',
            terminal: true
          });
          return;
        }
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

export function waitForAcknowledgment(
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

export function acknowledgmentRetryAfterMs(error: unknown): number | null {
  const milliseconds = Number(property(error, 'retryAfterMs'));
  if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.ceil(milliseconds);
  const seconds = Number(property(error, 'retry_after'));
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  return null;
}
