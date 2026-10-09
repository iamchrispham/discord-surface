function createMessageRecoveryHandlers({ boardRefreshHandlers, topicPublicationHandlers, decisionHandlers, courierRouteHandlers, MESSAGE_STATES, COURIER_OUTCOMES, COURIER_RECEIPT_KINDS, TRANSPORT_RECEIPT_OUTCOME, TRANSPORT_RECEIPT_ATTEMPT, INTERACTION_TRANSPORT, parseJson, now, BindingError }) {
  return {
  recoverAfterRestart(ownerAlive = null) {
    return this.transaction(() => {
      boardRefreshHandlers.recoverBoardRefreshReceipts(this, ownerAlive || ((pid, identity) => typeof this.directPostOwnerEvidence === 'function' ? this.directPostOwnerEvidence(pid, identity) : null), true);
      this.recoverDirectPostReceiptsInternal();
      topicPublicationHandlers.recoverTopicPublications.call(this);
      const transportAttempts = this.db.prepare(`
        SELECT attempt.discord_id, attempt.detail
        FROM receipts AS attempt
        LEFT JOIN receipts AS outcome
          ON outcome.discord_id = attempt.discord_id
         AND outcome.kind = ?
         AND outcome.id > attempt.id
        WHERE attempt.kind = ? AND outcome.id IS NULL
          AND COALESCE(json_extract(attempt.detail, '$.transport'), '') <> ?
        ORDER BY attempt.id
      `).all(TRANSPORT_RECEIPT_OUTCOME, TRANSPORT_RECEIPT_ATTEMPT, INTERACTION_TRANSPORT);
      for (const row of transportAttempts) {
        this.receipt(row.discord_id, TRANSPORT_RECEIPT_OUTCOME, {
          ...parseJson(row.detail, {}),
          outcome: 'unknown',
          reason: 'process stopped before transport receipt outcome'
        });
      }
      const interactionCallbacks = this.recoverInteractionCallbacksInTransaction(ownerAlive);
      decisionHandlers.recoverCallbackAttemptsAfterRestart(this);
      const courierAttempts = courierRouteHandlers.recoverCourierAttemptsAfterRestart(this, { inTransaction: true });
      const dispatching = this.db.prepare('SELECT discord_id FROM messages WHERE state=?').all(MESSAGE_STATES.DISPATCHING);
      for (const row of dispatching) {
        const message = this.getMessage(row.discord_id);
        const courierAttempt = this.getCourierAttempt(row.discord_id);
        const courierRetired = Boolean(courierAttempt &&
          this.hasRetiredCourierAttempt(row.discord_id, courierAttempt.attempt.receiptId));
        const courierOutcome = courierRetired ? null : courierAttempt?.outcome?.outcome;
        if (this.hasNativeAcknowledgment(message)) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
          this.receipt(row.discord_id, 'dispatch-already-acknowledged', { generation: message.generation, afterRestart: true });
          continue;
        }
        if (message.watcherNotice && courierRetired && !this.hasCourierForwardClaim(row.discord_id)) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.ACCEPTED, now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
          this.receipt(row.discord_id, 'dispatch-not-submitted-after-restart', { afterRestart: true, retiredAttemptId: courierAttempt.attempt.attemptId });
          continue;
        }
        if (courierOutcome === COURIER_OUTCOMES.SUBMITTED) {
          const marker = `[[discord-surface:${row.discord_id}]]`;
          this.db.prepare('UPDATE messages SET state=?, observer_marker=COALESCE(observer_marker, ?), error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, marker, now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
          this.receipt(row.discord_id, 'submitted', { marker, afterRestart: true });
          continue;
        }
        if (courierOutcome === COURIER_OUTCOMES.NOT_SUBMITTED) {
          if (this.hasCourierForwardClaim(row.discord_id)) {
            this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=? AND state=?')
              .run(MESSAGE_STATES.UNCERTAIN, 'process stopped after courier forward claim', now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
            this.receipt(row.discord_id, 'dispatch-uncertain-after-restart', {
              afterRestart: true,
              reason: 'courier forward claim fence'
            });
            continue;
          }
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.ACCEPTED, now(), row.discord_id, MESSAGE_STATES.DISPATCHING);
          this.receipt(row.discord_id, 'dispatch-not-submitted-after-restart', { afterRestart: true });
          continue;
        }
        this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.UNCERTAIN, 'process stopped at dispatch boundary', now(), row.discord_id);
        this.receipt(row.discord_id, 'dispatch-uncertain-after-restart', {});
      }
      const replying = this.db.prepare('SELECT discord_id FROM messages WHERE state=?').all(MESSAGE_STATES.REPLYING);
      for (const row of replying) {
        this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLY_UNKNOWN, 'process stopped during reply delivery', now(), row.discord_id);
        this.db.prepare("UPDATE reply_parts SET state='unknown', updated_at=? WHERE discord_id=? AND state='sending'").run(now(), row.discord_id);
        this.receipt(row.discord_id, 'reply-unknown-after-restart', {});
      }
      const candidates = this.recoveryCandidates();
      return { dispatching: dispatching.length, replying: replying.length, interactionCallbacks, courierAttempts, candidates: candidates.map(row => row.id) };
    });
  },
  recoveryCandidates(before = null) {
    const states = [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY];
    const rows = before
      ? this.db.prepare(`SELECT discord_id FROM messages WHERE state IN (?, ?, ?) AND created_at<=? ORDER BY created_at, rowid`).all(...states, before)
      : this.db.prepare(`SELECT discord_id FROM messages WHERE state IN (?, ?, ?) ORDER BY created_at, rowid`).all(...states);
    return rows.map(row => this.getMessage(row.discord_id));
  },
  reconcileUncertain(messageId, resolution) {
    if (!['submitted', 'not_submitted'].includes(resolution)) throw new BindingError('resolution must be submitted or not_submitted');
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is not uncertain');
      if (resolution === 'not_submitted' && this.hasNativeAcknowledgment(message)) {
        throw new BindingError('native acknowledgment prevents retrying delivery');
      }
      if (resolution === 'not_submitted' && this.hasCourierForwardClaim(messageId)) {
        throw new BindingError('courier forwarding claim prevents retrying delivery');
      }
      if (message.state !== MESSAGE_STATES.UNCERTAIN) throw new BindingError('message is not uncertain');
      const next = resolution === 'submitted' ? MESSAGE_STATES.SUBMITTED : MESSAGE_STATES.ACCEPTED;
      this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(next, now(), messageId, MESSAGE_STATES.UNCERTAIN);
      const receiptKind = resolution === 'not_submitted'
        ? COURIER_RECEIPT_KINDS.RECONCILED_NOT_SUBMITTED
        : `uncertain-reconciled-${resolution}`;
      this.receipt(messageId, receiptKind, {});
      return this.getMessage(messageId);
    });
  }
  };
}

module.exports = { createMessageRecoveryHandlers };
