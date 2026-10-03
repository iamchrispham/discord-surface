const { REACTION } = require('../acknowledgment');
const { READINESS, TRANSPORT_RECEIPT_OUTCOMES } = require('../state');
const { cancelResponseBody, readRetryAfter, sendDiscordMessage } = require('./http-transport');

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

async function sendGatewayTransportReceipt(gateway, message, receipt, waitForRecoveryOperation) {
  const controller = new AbortController();
  gateway.receiptControllers.add(controller);
  try {
    let sendPromise;
    try {
      const stored = gateway.state.getMessage(message.id);
      if (stored?.deliveryChannelId && stored.deliveryChannelId !== stored.channelId) {
        message = await waitForRecoveryOperation(() => gateway.threadDeliveryMessage(message), controller.signal, Date.now() + gateway.recoveryTimeoutMs);
        gateway.state.assertMessageCurrent(message.id, 'transport-receipt-send');
      }
      // discord.js channel.send drops the signal and uses the shared REST retry queue.
      if (gateway.discordToken && gateway.client?.rest && typeof globalThis.fetch === 'function') {
        if (receipt.reaction) {
          const channelId = message.channelId || message.channel.id;
          const targetMessageId = receipt.targetMessageId || message.id;
          const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(targetMessageId)}/reactions/${encodeURIComponent(receipt.reaction)}/@me`;
          sendPromise = globalThis.fetch(url, {
            method: 'PUT',
            headers: {
              Authorization: `Bot ${gateway.discordToken}`,
              'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
              'Content-Type': 'application/json'
            },
            signal: controller.signal
          }).then(async response => {
            if (!response?.ok) {
              const retryAfter = response?.status === 429 ? await readRetryAfter(response) : null;
              await cancelResponseBody(response);
              const error = new Error('Discord acknowledgment request rejected');
              error.status = response?.status;
              if (retryAfter) {
                error.retryAfter = retryAfter.raw;
                error.retryAfterMs = retryAfter.milliseconds;
              }
              throw error;
            }
            await cancelResponseBody(response);
            return { id: targetMessageId, targetMessageId, reaction: receipt.reaction };
          });
        } else {
          sendPromise = sendDiscordMessage({
            token: gateway.discordToken, channelId: message.channelId || message.channel.id,
            content: receipt.content, nonce: receipt.nonce, signal: controller.signal,
            timeoutMs: gateway.recoveryTimeoutMs, allowedMentions: { parse: [], replied_user: false },
            messageReference: { message_id: message.id, fail_if_not_exists: false }
          });
        }
      } else if (gateway.discordToken && gateway.client?.rest) {
        throw new Error('Discord transport receipt fetch is unavailable');
      } else {
        const reactToFetchedMessage = async () => {
          const targetMessageId = receipt.targetMessageId || message.id;
          const source = await message.channel.messages.fetch(targetMessageId);
          gateway.state.assertMessageCurrent(message.id, 'native-ack-reaction');
          return source.react(receipt.reaction);
        };
        const targetMessageId = receipt.targetMessageId || message.id;
        sendPromise = receipt.reaction
          ? Promise.resolve(message.react && targetMessageId === message.id ? message.react(receipt.reaction) : reactToFetchedMessage())
            .then(() => ({ id: targetMessageId, targetMessageId, reaction: receipt.reaction }))
          : message.channel.send({
            content: receipt.content,
            nonce: receipt.nonce,
            enforceNonce: true,
            allowedMentions: receipt.allowedMentions,
            reply: receipt.reply
          });
      }
    } catch (error) {
      sendPromise = Promise.reject(error);
    }
    return await waitForRecoveryOperation(
      () => sendPromise,
      controller.signal,
      Date.now() + gateway.recoveryTimeoutMs,
      () => controller.abort()
    );
  } finally {
    gateway.receiptControllers.delete(controller);
  }
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

module.exports = { createTransportReceiptDelivery, sendGatewayTransportReceipt };
