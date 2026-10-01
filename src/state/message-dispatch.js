function createMessageDispatchHandlers({
  BindingError, StaleGenerationError, AuthorizationError, MESSAGE_STATES, READINESS,
  NATIVE_ACK_RECEIPT, parseJson, safeDetail, now, legacyAgentRequestRoute
}) {
  return {
    currentMessageBinding(message) {
    const config = this.requireConfig();
    const deliveryChannelId = message.deliveryChannelId || message.channelId;
    const route = typeof deliveryChannelId === 'string' && deliveryChannelId.length > 0
      ? this.getMessageRoute(deliveryChannelId)
      : null;
    const binding = route?.binding || this.getBinding(message.channelId);
    const enrollment = route?.enrollment || null;
    const routeIdentity = Boolean(route && route.binding.channelId === binding?.channelId &&
      route.binding.channelId === message.channelId &&
      (!enrollment || enrollment.guildId === binding?.guildId));
    const identity = Boolean(routeIdentity && binding && binding.active && binding.guildId === message.guildId &&
      binding.generation === message.generation && binding.nativeId === message.nativeId && binding.provider === message.provider);
    const current = Boolean(identity && binding.guildId === config.guildId &&
      message.guildId === config.guildId && (message.authorId === config.operatorId || this.getAgentMessage(message.id)?.authorId === message.authorId || this.getWatcherNotice(message.id)?.authorId === message.authorId) &&
      binding.generation === message.generation && binding.nativeId === message.nativeId && binding.provider === message.provider);
    return { config, binding, identity, current, enrollment, deliveryChannelId, ready: Boolean(identity && route?.ready) };
  },

  hasNativeAcknowledgment(message) {
    const row = this.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
      .get(message.id, NATIVE_ACK_RECEIPT);
    const identity = parseJson(row?.detail, null);
    return Boolean(identity && identity.provider === message.provider && identity.nativeId === message.nativeId && identity.generation === message.generation);
  },

  recoverNativeReplyAcknowledgment(messageId) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || message.state !== MESSAGE_STATES.REPLY_READY) return { recovered: false, reason: 'not-reply-ready' };
      const check = this.currentMessageBinding(message);
      if (!check.current) return { recovered: false, reason: check.identity ? 'authorization-revoked' : 'stale-generation' };
      if (this.hasNativeAcknowledgment(message)) return { recovered: false, duplicate: true };
      const receiptRows = this.db.prepare(`SELECT detail FROM receipts
        WHERE discord_id=? AND kind IN (?, ?) ORDER BY id DESC`).all(messageId, 'native-reply', 'native-reply-before-submit');
      const partCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=?').get(messageId).count);
      const provenance = receiptRows
        .map(row => parseJson(row.detail, null))
        .find(detail => detail && detail.generation === message.generation && Number.isInteger(detail.parts) && detail.parts > 0 && detail.parts === partCount);
      if (!provenance) return { recovered: false, reason: 'native-reply-provenance-missing' };
      this.receipt(messageId, NATIVE_ACK_RECEIPT, {
        provider: message.provider,
        nativeId: message.nativeId,
        generation: message.generation,
        source: 'native-reply'
      });
      return { recovered: true, message: this.getMessage(messageId) };
    });
  },

  assertMessageCurrent(messageId, phase) {
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new BindingError('message is unknown');
        const check = this.currentMessageBinding(message);
        if (!check.identity) throw new StaleGenerationError('message binding generation is stale');
        if (!check.current) throw new AuthorizationError(`message authorization is no longer valid at ${phase}`);
        return message;
      });
    } catch (error) {
      if (error instanceof AuthorizationError) this.auditReceipt(messageId, `${phase}-rejected-auth`, {});
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, `${phase}-stale`, {});
      throw error;
    }
  },

  claimDispatch(messageId) {
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new BindingError('message is unknown');
        if (message.state !== MESSAGE_STATES.ACCEPTED) return { claimed: false, message };
        const check = this.currentMessageBinding(message);
        if (!check.identity) throw new StaleGenerationError('message binding generation is stale');
        if (!check.current) {
          this.receipt(messageId, 'dispatch-rejected-auth', { generation: message.generation });
          return { claimed: false, message, reason: 'authorization-revoked' };
        }
        if (this.hasNativeAcknowledgment(message)) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, now(), messageId, MESSAGE_STATES.ACCEPTED);
          this.receipt(messageId, 'dispatch-already-acknowledged', { generation: message.generation });
          return { claimed: false, message: this.getMessage(messageId), reason: 'native-already-acknowledged' };
        }
        if (this.hasCourierForwardClaim(messageId)) {
          return { claimed: false, message, reason: 'courier-forward-already-claimed' };
        }
        if (check.binding.readiness !== READINESS.READY || !check.ready) {
          this.receipt(messageId, 'dispatch-held-not-ready', {
            readiness: check.binding.readiness,
            ...(check.enrollment ? { threadState: check.enrollment.state } : {}),
            generation: message.generation
          });
          return { claimed: false, message, reason: 'binding-not-ready' };
        }
        const agentRoute = legacyAgentRequestRoute.claimRoute(this, message);
        if (!agentRoute.ready) return { claimed: false, message, reason: agentRoute.reason };
        this.db.prepare('UPDATE messages SET state=?, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.DISPATCHING, now(), messageId, MESSAGE_STATES.ACCEPTED);
        this.receipt(messageId, 'dispatching', { generation: message.generation });
        return { claimed: true, message: this.getMessage(messageId) };
      });
    } catch (error) {
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, 'dispatch-stale', {});
      throw error;
    }
  },

  markSubmitted(messageId, cursor = null, marker = null) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      const serializedCursor = cursor === null || cursor === undefined ? null : safeDetail(cursor);
      const submittedMarker = marker === undefined ? null : marker;
      if (message.state === MESSAGE_STATES.SUBMITTED) {
        if (serializedCursor === null && submittedMarker === null) return message;
        this.db.prepare('UPDATE messages SET observer_cursor=COALESCE(observer_cursor, ?), observer_marker=COALESCE(observer_marker, ?), updated_at=? WHERE discord_id=? AND state=?')
          .run(serializedCursor, submittedMarker, now(), messageId, MESSAGE_STATES.SUBMITTED);
        return this.getMessage(messageId);
      }
      if (message.state !== MESSAGE_STATES.DISPATCHING) return message;
      this.db.prepare('UPDATE messages SET state=?, observer_cursor=?, observer_marker=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(MESSAGE_STATES.SUBMITTED, serializedCursor, submittedMarker, now(), messageId, MESSAGE_STATES.DISPATCHING);
      this.receipt(messageId, 'submitted', { marker: marker || undefined });
      return this.getMessage(messageId);
    });
  },

  setObserverCursor(messageId, cursor, marker = null) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || ![MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLIED].includes(message.state)) return message;
      this.db.prepare('UPDATE messages SET observer_cursor=?, observer_marker=COALESCE(?, observer_marker), updated_at=? WHERE discord_id=?')
        .run(safeDetail(cursor), marker, now(), messageId);
      return this.getMessage(messageId);
    });
  },

  markObservationUnavailable(messageId, detail) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || ![MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message.state)) return message;
      const error = String(detail?.message || detail || 'native observation unavailable').slice(0, 1000);
      this.db.prepare('UPDATE messages SET error=?, updated_at=? WHERE discord_id=?').run(error, now(), messageId);
      this.receipt(messageId, 'recovery-unavailable', { error: error.slice(0, 200) });
      return this.getMessage(messageId);
    });
  },

  markUncertain(messageId, error) {
    return this.transition(messageId, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.UNCERTAIN, 'dispatch-uncertain', error);
  },

  markNotSubmitted(messageId, error) {
    return this.transition(messageId, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.ACCEPTED, 'dispatch-not-submitted', error);
  },

  transition(messageId, expected, next, kind, error) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state !== expected) return message;
      let transitionNext = next;
      let transitionKind = kind;
      if (transitionNext === MESSAGE_STATES.ACCEPTED && this.hasCourierForwardClaim(messageId)) {
        transitionNext = MESSAGE_STATES.UNCERTAIN;
        transitionKind = 'dispatch-uncertain-after-forward-claim';
      }
      if ([MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.UNCERTAIN].includes(transitionNext) && this.hasNativeAcknowledgment(message)) {
        this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.SUBMITTED, now(), messageId, expected);
        this.receipt(messageId, 'dispatch-already-acknowledged', { generation: message.generation });
        return this.getMessage(messageId);
      }
      this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=? AND state=?')
        .run(transitionNext, error ? String(error.message || error).slice(0, 1000) : null, now(), messageId, expected);
      this.receipt(messageId, transitionKind, { error: error ? String(error.message || error).slice(0, 200) : undefined });
      return this.getMessage(messageId);
    });
  }
  };
}

module.exports = { createMessageDispatchHandlers };
