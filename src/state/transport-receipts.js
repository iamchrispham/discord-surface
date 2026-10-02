function createTransportReceiptHandlers({
  assertText, BindingError, MESSAGE_STATES, INTERACTION_TRANSPORT, READINESS, bindingMatchesExpected,
  parseJson, TRANSPORT_RECEIPT_ATTEMPT, TRANSPORT_RECEIPT_OUTCOME, TRANSPORT_RECEIPT_OUTCOMES, discordNonce
}) {
  function transportReceiptNonce(messageId) {
    return discordNonce(`transport:${messageId}`, 0);
  }

  return {
  getTransportReceipt(messageId, transport = null) {
    assertText(messageId, 'messageId', 128);
    const rows = this.db.prepare('SELECT kind, detail, created_at FROM receipts WHERE discord_id=? AND kind IN (?, ?) ORDER BY id')
      .all(messageId, TRANSPORT_RECEIPT_ATTEMPT, TRANSPORT_RECEIPT_OUTCOME);
    let attempt = null;
    let outcome = null;
    for (const row of rows) {
      const detail = parseJson(row.detail, {});
      if (transport !== null && detail.transport !== transport) continue;
      if (row.kind === TRANSPORT_RECEIPT_ATTEMPT) attempt = { ...detail, recordedAt: row.created_at };
      if (row.kind === TRANSPORT_RECEIPT_OUTCOME) outcome = { ...detail, recordedAt: row.created_at };
    }
    if (!attempt && !outcome) return null;
    return { messageId, attempt, outcome };
  },

  beginTransportReceipt(messageId, { transport = null, ownerPid = null, ownerIdentity = null, inTransaction = false } = {}) {
    assertText(messageId, 'messageId', 128);
    const begin = () => {
      const existing = this.getTransportReceipt(messageId, transport);
      if (existing) return { started: false, ...existing, reason: 'already-attempted' };
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state !== MESSAGE_STATES.ACCEPTED) return { started: false, message, reason: 'message-not-accepted' };
      if (transport === INTERACTION_TRANSPORT && !this.isInteractionMessage(messageId)) {
        throw new BindingError('interaction callback origin is unknown');
      }
      const check = this.currentMessageBinding(message);
      if (!check.current) {
        const detail = { nonce: transportReceiptNonce(messageId), outcome: 'stale', reason: 'authorization revoked before receipt attempt' };
        this.receipt(messageId, TRANSPORT_RECEIPT_OUTCOME, detail);
        return { started: false, message, outcome: detail.outcome, detail, reason: 'stale-authority' };
      }
      const detail = {
        nonce: transportReceiptNonce(messageId),
        channelId: message.channelId,
        provider: check.binding.provider,
        conductorId: check.binding.conductorId,
        repoKey: check.binding.repoKey,
        generation: check.binding.generation,
        readiness: check.binding.readiness === READINESS.READY
          ? (check.enrollment?.state || READINESS.READY)
          : check.binding.readiness,
        status: 'attempted'
      };
      if (check.enrollment) detail.deliveryChannelId = check.deliveryChannelId;
      if (transport !== null) detail.transport = transport;
      if (ownerPid !== null) detail.ownerPid = ownerPid;
      if (ownerIdentity !== null) detail.ownerIdentity = ownerIdentity;
      this.receipt(messageId, TRANSPORT_RECEIPT_ATTEMPT, detail);
      return { started: true, message, binding: check.binding, attempt: detail, nonce: detail.nonce };
    };
    return inTransaction ? begin() : this.transaction(begin);
  },

  authorizeTransportReceipt(messageId, expectedBinding) {
    assertText(messageId, 'messageId', 128);
    return this.transaction(() => {
      const record = this.getTransportReceipt(messageId);
      if (!record?.attempt || record.outcome) return null;
      const message = this.getMessage(messageId);
      const check = message ? this.currentMessageBinding(message) : null;
      if (!check?.current || !bindingMatchesExpected(check.binding, expectedBinding)) return null;
      return { message, binding: check.binding, attempt: record.attempt, nonce: record.attempt.nonce };
    });
  },

  recordTransportReceiptOutcome(messageId, outcome, detail = {}, transport = null) {
    assertText(messageId, 'messageId', 128);
    if (!TRANSPORT_RECEIPT_OUTCOMES.includes(outcome)) throw new BindingError('invalid transport receipt outcome');
    return this.transaction(() => {
      const record = this.getTransportReceipt(messageId, transport);
      if (!record?.attempt) throw new BindingError('transport receipt attempt is unknown');
      if (record.outcome) return record;
      const next = { ...detail, nonce: record.attempt.nonce, outcome };
      this.receipt(messageId, TRANSPORT_RECEIPT_OUTCOME, next);
      return this.getTransportReceipt(messageId);
    });
  }
  };
}

module.exports = { createTransportReceiptHandlers };
