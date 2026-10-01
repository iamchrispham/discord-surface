function createReplyDelivery({ state, sendReply, prepareReply, ACK_WAITING, MESSAGE_STATES, classifyReplyError }) {
  async function deliverReply(message, result, signal) {
    if (result.message?.state !== 'reply_ready') return result;
    if (prepareReply) {
      try {
        const preparation = prepareReply(result.message.id, signal);
        const prepared = preparation ? await preparation : preparation;
        if (prepared === ACK_WAITING) return { ...result, message: state.getMessage(result.message.id) };
      }
      catch (error) { return { ...result, message: state.getMessage(result.message.id), error }; }
      if (signal?.aborted) return { ...result, message: state.getMessage(result.message.id) };
    }
    let ready;
    try {
      ready = state.beginReply(result.message.id);
    } catch (error) {
      return { ...result, message: state.getMessage(result.message.id), error };
    }
    if (ready.sent) return { ...result, message: ready.message };
    const parts = ready.message.replyParts?.length ? ready.message.replyParts : [{ index: 0, content: ready.message.replyText, nonce: ready.message.replyNonce, state: 'sending' }];
    for (const part of parts) {
      if (part.state === 'sent') continue;
      if (signal?.aborted) return { ...result, message: state.markReplyFailure(ready.message.id, new Error('reply delivery stopped'), true, part.index) };
      try {
        state.assertMessageCurrent(ready.message.id, 'reply-send');
        if (!part.content.trim() && !part.fileManifest) {
          const skipped = state.markReplyPartSkipped(ready.message.id, part.index);
          if (skipped.state === 'replied') return { ...result, message: skipped };
          continue;
        }
        if (part.content.length > 2000) throw new Error('Discord reply part exceeds 2000 characters');
        const sent = await sendReply(message, { ...ready.message, replyText: part.content, replyNonce: part.nonce, replyPart: part });
        const replyId = sent?.id || sent?.messageId;
        if (!replyId) throw new Error('Discord did not return a message id');
        let saved;
        try {
          saved = state.markReplyPartSent(ready.message.id, part.index, replyId);
        } catch (error) {
          const current = state.getMessage(ready.message.id);
          if (current?.state !== MESSAGE_STATES.REPLY_UNKNOWN || typeof state.reconcileReplyDelivery !== 'function') throw error;
          saved = state.reconcileReplyDelivery(ready.message.id, 'sent', {
            partIndex: part.index,
            replyMessageId: replyId
          });
        }
        if (saved.state === 'replied') return { ...result, message: saved };
      } catch (error) {
        const unknown = classifyReplyError(error) === 'unknown';
        return { ...result, message: state.markReplyFailure(ready.message.id, error, unknown, part.index), error };
      }
    }
    return { ...result, message: state.getMessage(ready.message.id) };
  }
  return deliverReply;
}

module.exports = { createReplyDelivery };
