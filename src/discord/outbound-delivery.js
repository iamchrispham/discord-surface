'use strict';

function createOutboundDeliveryHandlers({ bindingIdentityMatches, recoveryKind, CODEX_VALIDATION_KINDS, classifyRecoveryFailure, isRetryableFetchBoundary, THREAD_STATES, recoveryFetch, assertPublicThread, storedChannelMatches, readDirectPostFileSnapshot, classifyReplyError, waitForAcknowledgment }) {
  return {
    markThreadDeliveryUnavailable(message, error) {
    const stored = this.state.getMessage(message.id);
    if (!stored?.deliveryChannelId || stored.deliveryChannelId === stored.channelId) return;
    const binding = this.state.getBinding(stored.channelId);
    if (!bindingIdentityMatches(stored, binding)) return;
    const enrollment = this.state.getThreadEnrollment(stored.deliveryChannelId);
    if (!enrollment) return;
    const detail = recoveryKind(error) === CODEX_VALIDATION_KINDS.DEADLINE
      ? classifyRecoveryFailure(error).detail
      : error.message;
    const retryableBoundary = isRetryableFetchBoundary(enrollment.state, enrollment.detail);
    const retryableFetch = isRetryableFetchBoundary(THREAD_STATES.UNAVAILABLE, detail);
    if (['gap', 'unavailable'].includes(enrollment.state) && !retryableBoundary) return;
    const nextState = !enrollment.adoptedAt && retryableFetch ? THREAD_STATES.PENDING : THREAD_STATES.UNAVAILABLE;
    this.markThreadBoundary(stored.deliveryChannelId, nextState,
      detail, null, null, binding, undefined, undefined, enrollment);
  },
    async threadDeliveryMessage(message) {
    const stored = this.state.getMessage(message.id);
    if (!stored?.deliveryChannelId || stored.deliveryChannelId === stored.channelId) return message;
    const binding = this.state.getBinding(stored.channelId);
    const route = this.state.getMessageRoute(stored.deliveryChannelId);
    if (!route) throw Object.assign(new Error('Thread delivery has no active parent route'), { outcome: 'not_sent' });
    let channel;
    try {
      channel = message.channel?.id === stored.deliveryChannelId ? message.channel :
        await recoveryFetch(() => this.client.channels.fetch(stored.deliveryChannelId));
      assertPublicThread(channel, binding, stored.deliveryChannelId, this.client.user);
    }
    catch (error) {
      const deliveryError = error instanceof Error ? error : new Error(String(error));
      this.markThreadDeliveryUnavailable(stored, deliveryError);
      deliveryError.outcome = 'not_sent';
      throw deliveryError;
    }
    return { ...message, channelId: stored.deliveryChannelId, channel };
  },
    async sendReply(message, reply) {
    const stored = this.state.getMessage(message.id);
    const isThreadDelivery = Boolean(stored?.deliveryChannelId && stored.deliveryChannelId !== stored.channelId);
    message = await this.threadDeliveryMessage(message);
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    if (typeof reply.replyText !== 'string' || reply.replyText.length > 2000) throw new Error('Discord reply must be at most 2000 characters per message');
    if (typeof reply.replyNonce !== 'string' || reply.replyNonce.length > 25) throw new Error('Discord reply nonce must be at most 25 characters');
    const channel = message.channel || await this.client.channels?.fetch?.(message.deliveryChannelId || message.channelId);
    if (!channel?.send) throw new Error('Discord reply channel is unavailable');
    // F12: an explicit guild/channel mismatch on the resolved destination is a
    // definitive not-sent outcome. Nothing is sent and the saved reply keeps its
    // stored tuple. Missing stored metadata stays compatible.
    if (!storedChannelMatches(channel, stored)) {
      throw Object.assign(new Error('Discord reply channel does not match the stored message destination'), { outcome: 'not_sent' });
    }
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    const fileManifest = reply.replyPart?.fileManifest || null;
    const files = fileManifest
      ? [{ attachment: readDirectPostFileSnapshot(fileManifest), name: fileManifest.filename }]
      : undefined;
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    try {
      return await channel.send({
        content: reply.replyText,
        nonce: reply.replyNonce,
        enforceNonce: true,
        allowedMentions: { parse: [] },
        ...(files ? { files } : {})
      });
    } catch (error) {
      const definitiveThreadRejection = isThreadDelivery &&
        ([403, 404].includes(Number(error?.status)) || error?.code === 50013);
      if (definitiveThreadRejection) {
        const deliveryError = error instanceof Error ? error : new Error(String(error));
        this.markThreadDeliveryUnavailable(message, deliveryError);
      }
      if (!error.outcome) error.outcome = classifyReplyError(error);
      throw error;
    }
  },
    prepareReply(messageId, signal) {
    if (signal?.aborted || this.stopping) return;
    return waitForAcknowledgment(this.state, this.deliverAcknowledgment, messageId, signal);
  },
    async sendAcknowledgment(message, reaction) {
    if (this.stopping) throw new Error('Discord acknowledgment stopped');
    this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
    const interaction = this.state.isInteractionMessage?.(message.id);
    const targetMessageId = interaction ? this.state.interactionResponseTarget?.(message.id) : message.id;
    if (interaction && !targetMessageId) {
      throw Object.assign(new Error('interaction callback response target is unavailable'), {
        outcome: 'local_visibility_failure', visibility: 'local', targetMessageId: null
      });
    }
    let source = message;
    if (!source.channel && !(this.discordToken && this.client?.rest)) {
      const channel = await this.client.channels?.fetch?.(message.deliveryChannelId || message.channelId);
      if (!channel) throw new Error('Discord acknowledgment channel is unavailable');
      source = { ...message, channel };
    }
    this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
    try {
      return await this.sendTransportReceipt(source, { reaction, targetMessageId: targetMessageId || message.id });
    } catch (error) {
      if ([400, 401, 403, 404].includes(Number(error?.status))) {
        error.visibility = 'local';
        error.targetMessageId = targetMessageId || message.id;
      }
      throw error;
    }
  }
  };
}

module.exports = { createOutboundDeliveryHandlers };
