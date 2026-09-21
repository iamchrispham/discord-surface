function createReplyLifecycleHandlers({ assertProvider, assertText, assertUuid, StaleGenerationError, assertNativeReplyFileManifest, BindingError, REPLY_LIMIT, AuthorizationError, NATIVE_ACK_RECEIPT, MESSAGE_STATES, now, NATIVE_REPLY_FILE_PHASES, splitReply, discordNonce, safeDetail, REPLY_COMPLETED_WITHOUT_POST, rowReplyPart }) {
  return {
    recordNativeReply({ provider, messageId, nativeId, generation, text, parts: prepartitionedParts, fileManifest = null }) {
    assertProvider(provider);
    assertText(messageId, 'messageId', 128);
    assertUuid(nativeId);
    if (!Number.isInteger(generation) || generation < 1) throw new StaleGenerationError('invalid generation');
    const hasPrepartitionedParts = Array.isArray(prepartitionedParts);
    if (!(hasPrepartitionedParts && text === '')) assertText(text, 'reply text', 10000);
    if (fileManifest !== null) {
      try { assertNativeReplyFileManifest(fileManifest); }
      catch (error) { throw new BindingError(error.message); }
      if (!text.trim() || text.length > REPLY_LIMIT) throw new BindingError('file replies require one nonblank caption at most 2000 characters');
    }
    try {
      return this.transaction(() => {
        let message = this.getMessage(messageId);
        if (!message) throw new StaleGenerationError('native reply is stale');
        const check = this.currentMessageBinding(message);
        if (message.provider !== provider || !check.binding || message.nativeId !== nativeId || message.generation !== generation ||
          check.binding.nativeId !== nativeId || check.binding.generation !== generation || check.binding.provider !== message.provider || check.binding.provider !== provider) {
          throw new StaleGenerationError('native reply is stale');
        }
        if (!check.current) throw new AuthorizationError('native reply authorization is no longer valid');
        const ensureNativeReplyAcknowledgment = () => {
          const existing = this.db.prepare('SELECT 1 FROM receipts WHERE discord_id=? AND kind=? LIMIT 1')
            .get(messageId, NATIVE_ACK_RECEIPT);
          if (!existing) this.receipt(messageId, NATIVE_ACK_RECEIPT, { provider, nativeId, generation, source: 'native-reply' });
        };
        ensureNativeReplyAcknowledgment();
        if (message.state === MESSAGE_STATES.UNCERTAIN) {
          this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.SUBMITTED, now(), messageId, MESSAGE_STATES.UNCERTAIN);
          message = this.getMessage(messageId);
        }
        if (message.state === MESSAGE_STATES.REPLY_READY || message.state === MESSAGE_STATES.REPLIED) {
          return { duplicate: true, message };
        }
        if (![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.DISPATCHING].includes(message.state)) throw new BindingError(`reply is not accepted in state ${message.state}`);
        const admittedFile = this.nativeReplyFilePreparation(messageId);
        if (admittedFile?.phase === NATIVE_REPLY_FILE_PHASES.PREPARING) {
          throw new BindingError('native reply file preparation is still in progress');
        }
        if (admittedFile?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED && fileManifest === null) {
          throw new BindingError('native reply file custody requires its admitted attachment');
        }
        if (fileManifest !== null) {
          if (!admittedFile || admittedFile.phase !== NATIVE_REPLY_FILE_PHASES.ADMITTED ||
            admittedFile.preparationId !== fileManifest.preparationId || admittedFile.stagedPath !== fileManifest.stagedPath ||
            admittedFile.filename !== fileManifest.filename || admittedFile.size !== fileManifest.size ||
            admittedFile.sha256 !== fileManifest.sha256 || admittedFile.caption !== fileManifest.caption ||
            admittedFile.captionHash !== fileManifest.captionHash || admittedFile.caption !== text) {
            throw new BindingError('native reply file preparation is not admitted for this reply');
          }
        }
        const timestamp = now();
        const parts = hasPrepartitionedParts ? prepartitionedParts.slice() : splitReply(text);
        if ((!parts.length && text !== '') || parts.some(part => typeof part !== 'string' || part.length > REPLY_LIMIT) || parts.join('') !== text) {
          throw new BindingError('reply parts are invalid');
        }
        if (fileManifest !== null && (parts.length !== 1 || parts[0] !== text)) {
          throw new BindingError('file replies require exactly one caption part');
        }
        if (fileManifest === null && text === '' && parts.every(part => part.length === 0)) {
          this.db.prepare('UPDATE messages SET state=?, reply_text=?, reply_nonce=?, reply_message_id=NULL, reply_next_part=0, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
            .run(MESSAGE_STATES.REPLIED, text, discordNonce(messageId, 0), timestamp, messageId, message.state);
          this.db.prepare('DELETE FROM reply_parts WHERE discord_id=?').run(messageId);
          this.receipt(messageId, message.state === MESSAGE_STATES.DISPATCHING ? 'native-reply-before-submit' : 'native-reply', { generation, parts: 0 });
          this.receipt(messageId, REPLY_COMPLETED_WITHOUT_POST, { generation });
          return { duplicate: false, message: this.getMessage(messageId) };
        }
        this.db.prepare('UPDATE messages SET state=?, reply_text=?, reply_nonce=?, reply_next_part=0, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLY_READY, text, discordNonce(messageId, 0), timestamp, messageId, message.state);
        this.db.prepare('DELETE FROM reply_parts WHERE discord_id=?').run(messageId);
        const insert = this.db.prepare('INSERT INTO reply_parts(discord_id, part_index, content, nonce, state, file_manifest, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)');
        parts.forEach((part, index) => insert.run(messageId, index, part, discordNonce(messageId, index), 'pending', index === 0 && fileManifest !== null ? safeDetail(fileManifest) : null, timestamp));
        this.receipt(messageId, message.state === MESSAGE_STATES.DISPATCHING ? 'native-reply-before-submit' : 'native-reply', { generation, parts: parts.length });
        return { duplicate: false, message: this.getMessage(messageId) };
      });
    } catch (error) {
      if (error instanceof AuthorizationError) this.auditReceipt(messageId, 'reply-rejected-auth', { generation });
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, 'reply-stale', { generation });
      throw error;
    }
  },

    listReplyParts(messageId) {
    return this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? ORDER BY part_index').all(messageId).map(rowReplyPart);
  },

    beginReply(messageId) {
    try {
      return this.transaction(() => {
        const message = this.getMessage(messageId);
        if (!message) throw new BindingError('message is unknown');
        if (message.state === MESSAGE_STATES.REPLIED) return { sent: true, message };
        if (message.state !== MESSAGE_STATES.REPLY_READY) throw new BindingError(`reply is not ready in state ${message.state}`);
        const check = this.currentMessageBinding(message);
        if (!check.identity) throw new StaleGenerationError('message binding generation is stale');
        if (!check.current) throw new AuthorizationError('reply authorization is no longer valid');
        this.db.prepare('UPDATE messages SET state=?, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLYING, now(), messageId, MESSAGE_STATES.REPLY_READY);
        this.db.prepare("UPDATE reply_parts SET state='sending', updated_at=? WHERE discord_id=? AND state='pending'").run(now(), messageId);
        this.receipt(messageId, 'reply-attempt', { nonce: message.replyNonce });
        return { sent: false, message: this.getMessage(messageId) };
      });
    } catch (error) {
      if (error instanceof AuthorizationError) this.auditReceipt(messageId, 'reply-rejected-auth', {});
      if (error instanceof StaleGenerationError) this.auditReceipt(messageId, 'reply-stale', {});
      throw error;
    }
  },

    markReplyPartSent(messageId, partIndex, replyMessageId) {
    assertText(replyMessageId, 'replyMessageId', 128);
    const result = this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state === MESSAGE_STATES.REPLIED) return message;
      if (message.state !== MESSAGE_STATES.REPLYING) throw new BindingError(`reply is not in flight in state ${message.state}`);
      const part = this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? AND part_index=?').get(messageId, partIndex);
      if (!part) throw new BindingError('reply part is unknown');
      if (part.state === 'sent') return message;
      this.db.prepare("UPDATE reply_parts SET state='sent', message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND part_index=?").run(replyMessageId, now(), messageId, partIndex);
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=? AND state<>'sent'").get(messageId).count;
      if (Number(remaining) === 0) {
        this.db.prepare('UPDATE messages SET state=?, reply_message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLIED, replyMessageId, now(), messageId, MESSAGE_STATES.REPLYING);
        this.receipt(messageId, 'reply-sent', { replyMessageId });
      } else {
        this.db.prepare('UPDATE messages SET reply_next_part=?, updated_at=? WHERE discord_id=?').run(Number(partIndex) + 1, now(), messageId);
        this.receipt(messageId, 'reply-part-sent', { partIndex, replyMessageId });
      }
      return this.getMessage(messageId);
    });
    return result;
  },

    markReplyPartSkipped(messageId, partIndex) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (message.state === MESSAGE_STATES.REPLIED) return message;
      if (message.state !== MESSAGE_STATES.REPLYING) throw new BindingError(`reply is not in flight in state ${message.state}`);
      const part = this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? AND part_index=?').get(messageId, partIndex);
      if (!part) throw new BindingError('reply part is unknown');
      if (part.file_manifest) throw new BindingError('file-bearing replies cannot be skipped');
      if (part.state === 'sent') return message;
      this.db.prepare("UPDATE reply_parts SET state='sent', message_id=NULL, error=NULL, updated_at=? WHERE discord_id=? AND part_index=?")
        .run(now(), messageId, partIndex);
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=? AND state<>'sent'").get(messageId).count;
      if (Number(remaining) === 0) {
        const lastPosted = this.db.prepare("SELECT message_id FROM reply_parts WHERE discord_id=? AND state='sent' AND message_id IS NOT NULL ORDER BY part_index DESC LIMIT 1").get(messageId);
        const replyMessageId = lastPosted?.message_id || null;
        this.db.prepare('UPDATE messages SET state=?, reply_message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
          .run(MESSAGE_STATES.REPLIED, replyMessageId, now(), messageId, MESSAGE_STATES.REPLYING);
        if (replyMessageId) this.receipt(messageId, 'reply-sent', { replyMessageId, skipped: true });
        else this.receipt(messageId, REPLY_COMPLETED_WITHOUT_POST, { generation: message.generation });
      } else {
        this.db.prepare('UPDATE messages SET reply_next_part=?, updated_at=? WHERE discord_id=?').run(Number(partIndex) + 1, now(), messageId);
        this.receipt(messageId, 'reply-part-skipped', { partIndex });
      }
      return this.getMessage(messageId);
    });
  },

    markReplySent(messageId, replyMessageId) {
    const parts = this.listReplyParts(messageId);
    if (parts.length > 1) throw new BindingError('multi-part replies must acknowledge each part separately');
    return this.markReplyPartSent(messageId, 0, replyMessageId);
  },

    markReplyFailure(messageId, error, unknown = false, partIndex = null) {
    return this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message) throw new BindingError('message is unknown');
      if (![MESSAGE_STATES.REPLYING, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)) return message;
      const next = unknown ? MESSAGE_STATES.REPLY_UNKNOWN : MESSAGE_STATES.REPLY_FAILED;
      const text = String(error?.message || error || 'reply failed').slice(0, 1000);
      if (partIndex !== null) this.db.prepare('UPDATE reply_parts SET state=?, error=?, updated_at=? WHERE discord_id=? AND part_index=?').run(unknown ? 'unknown' : 'failed', text, now(), messageId, partIndex);
      this.db.prepare('UPDATE messages SET state=?, error=?, updated_at=? WHERE discord_id=?').run(next, text, now(), messageId);
      this.receipt(messageId, unknown ? 'reply-unknown' : 'reply-failed', { partIndex, error: text.slice(0, 200) });
      return this.getMessage(messageId);
    });
  },

    reconcileReplyDelivery(messageId, resolution, { partIndex = null, replyMessageId = null } = {}) {
    if (!['sent', 'not_sent'].includes(resolution)) throw new BindingError('reply resolution must be sent or not_sent');
    const result = this.transaction(() => {
      const message = this.getMessage(messageId);
      if (!message || ![MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)) {
        throw new BindingError('message does not need reply delivery reconciliation');
      }
      if (resolution === 'not_sent') {
        this.db.prepare("UPDATE reply_parts SET state='pending', error=NULL, updated_at=? WHERE discord_id=? AND state IN ('sending', 'failed', 'unknown')")
          .run(now(), messageId);
        this.db.prepare('UPDATE messages SET state=?, error=NULL, reply_next_part=0, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLY_READY, now(), messageId);
        this.receipt(messageId, 'reply-reconciled-not-sent', {});
        return this.getMessage(messageId);
      }
      if (!Number.isInteger(partIndex) || partIndex < 0) throw new BindingError('sent reconciliation requires partIndex');
      assertText(replyMessageId, 'replyMessageId', 128);
      const part = this.db.prepare('SELECT * FROM reply_parts WHERE discord_id=? AND part_index=?').get(messageId, partIndex);
      if (!part || !['sending', 'failed', 'unknown'].includes(part.state)) throw new BindingError('reply part does not need sent reconciliation');
      this.db.prepare("UPDATE reply_parts SET state='sent', message_id=?, error=NULL, updated_at=? WHERE discord_id=? AND part_index=?")
        .run(replyMessageId, now(), messageId, partIndex);
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=? AND state<>'sent'").get(messageId).count;
      if (Number(remaining) === 0) {
        this.db.prepare('UPDATE messages SET state=?, reply_message_id=?, error=NULL, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLIED, replyMessageId, now(), messageId);
        this.receipt(messageId, 'reply-reconciled-sent', { partIndex, replyMessageId });
      } else {
        this.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=?')
          .run(MESSAGE_STATES.REPLY_UNKNOWN, now(), messageId);
        this.receipt(messageId, 'reply-part-reconciled-sent', { partIndex, replyMessageId });
      }
      return this.getMessage(messageId);
    });
    return result;
  }
  };
}

module.exports = { createReplyLifecycleHandlers };
