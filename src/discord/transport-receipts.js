const { REACTION } = require('../acknowledgment');
const { READINESS, TRANSPORT_RECEIPT_OUTCOMES } = require('../state');

function classifyTransportReceiptError(error) {
  if (error?.outcome === 'not_sent') return 'not_sent';
  if (error?.outcome !== 'sent' && TRANSPORT_RECEIPT_OUTCOMES.includes(error?.outcome)) return error.outcome;
  if (error?.status === 429 || error?.code === 429 || /^RateLimitError(?:\[|$)/.test(String(error?.name || '')) || /^RateLimitError(?:\[|$)/.test(String(error?.message || ''))) return 'rate_limited';
  if ([400, 401, 403, 404].includes(error?.status) || error?.code === 50013) return 'rejected';
  return 'unknown';
}

function transportReceiptText(message, attempt) {
  if (attempt.readiness === 'ready') return 'Receipt: saved for this conductor.';
  return 'Receipt: saved. Delivery was paused when this receipt was prepared.';
}

function createTransportReceiptDelivery({ state, sendTransportReceipt, trackReceipt }) {
  const receiptWork = new Set();

  function trackReceiptWork(work) {
    const tracked = Promise.resolve(work).catch(() => null);
    receiptWork.add(tracked);
    tracked.finally(() => receiptWork.delete(tracked)).catch(() => {});
    trackReceipt?.(tracked);
    return tracked;
  }

  async function issueTransportReceipt(message) {
    const started = state.beginTransportReceipt(message.id);
    if (!started.started) return started;
    const authorized = state.authorizeTransportReceipt(message.id, started.binding);
    if (!authorized) return state.recordTransportReceiptOutcome(message.id, 'stale', { reason: 'authorization changed before receipt send' });
    const payload = {
      ...authorized.attempt,
      content: transportReceiptText(message, authorized.attempt),
      reaction: authorized.attempt.readiness === READINESS.READY ? REACTION.SAVED : null,
      nonce: authorized.nonce,
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
      reply: { messageReference: message.id, failIfNotExists: false }
    };
    const sender = sendTransportReceipt || (async (source, receipt) => {
      if (!receipt.reaction) return source.channel?.send(receipt);
      let target = source;
      if (typeof target.react !== 'function') {
        target = await source.channel?.messages?.fetch?.(source.id);
      }
      if (typeof target?.react !== 'function') {
        throw new Error('Discord source message does not support reactions');
      }
      await target.react(receipt.reaction);
      return { messageId: source.id };
    });
    try {
      const sent = await sender(message, payload);
      const receiptMessageId = sent?.id || sent?.messageId;
      if (!receiptMessageId) throw new Error('Discord did not return a transport receipt message id');
      return state.recordTransportReceiptOutcome(message.id, 'sent', payload.reaction
        ? { reaction: payload.reaction, targetMessageId: message.id }
        : { receiptMessageId });
    } catch (error) {
      return state.recordTransportReceiptOutcome(message.id, classifyTransportReceiptError(error), { error: String(error?.message || error).slice(0, 200) });
    }
  }

  function launchTransportReceipt(message) {
    return trackReceiptWork(issueTransportReceipt(message));
  }

  async function waitForReceipts() {
    await Promise.allSettled([...receiptWork]);
  }

  return { issueTransportReceipt, launchTransportReceipt, waitForReceipts };
}

module.exports = { createTransportReceiptDelivery };
