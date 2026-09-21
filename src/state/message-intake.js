const { PREFIX: AGENT_PREFIX, decodeAgentMessage } = require('../agent-message');
const { AGENT_ROUTING_VERSION } = require('./agent-routing');
const { WATCHER_NOTICE_PREFIX, decodeWatcherNotice, sameWatcherNotice } = require('../watcher-notice');
const { normalizeAttachments } = require('../attachments');
const { THREAD_STATES, THREAD_INTAKE_REASONS } = require('./thread-enrollment');
const { intakeCutoffDecision } = require('./intake');
const { WATCHER_NOTICE_RECEIPTS, WATCHER_NOTICE_JOURNAL, WATCHER_NOTICE_AUTHORITY, WATCHER_NOTICE_PUBLICATION_SOURCE } = require('./watcher-notice');

function createMessageIntakeHandlers({
  assertText, bindingMatchesExpected, INTAKE_BOUNDARY_DETAILS, threadEnrollmentHandlers,
  compareDiscordIds, watcherNoticeHandlers, BindingError, MESSAGE_STATES, now
}) {
  return {
    acceptDiscordMessage(event, { ready = true, coverageId = null, expectedBinding = null, agentToken = null } = {}) {
    const config = this.requireConfig();
    if (coverageId !== null) assertText(coverageId, 'coverageId', 128);
    const routeHint = typeof event?.channelId === 'string' && event.channelId.length > 0
      ? this.getMessageRoute(event.channelId)
      : null;
    const authorityHint = routeHint?.binding?.channelId || event?.channelId;
    if (typeof authorityHint === 'string') this.recoverInterruptedOrdinaryHandoffIntake(authorityHint, expectedBinding);
    let attachments;
    try { attachments = normalizeAttachments(event?.attachments); } catch { attachments = null; }
    const validEvent = event && [event.id, event.guildId, event.channelId, event.authorId].every(value => typeof value === 'string' && value.length > 0) &&
      typeof event.content === 'string' && event.content.length <= 10000 && attachments !== null && (event.content.length > 0 || attachments.length > 0);
    if (!validEvent) {
      if (event && [event.id, event.guildId, event.channelId].every(value => typeof value === 'string' && value.length > 0)) {
        const result = this.transaction(() => {
          const route = this.getMessageRoute(event.channelId);
          const binding = route?.binding || this.getBinding(event.channelId);
          const enrollment = route?.enrollment || null;
          const authorityChannelId = binding?.channelId || event.channelId;
          if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
          if (this.ordinaryHandoffPauses.has(authorityChannelId) || this.getIntakeWatermark(authorityChannelId)?.detail === INTAKE_BOUNDARY_DETAILS.ORDINARY_HANDOFF) {
            if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, false);
            else this.upsertIntakeWatermark(event, false, null);
            this.receipt(null, 'intake-rejected', {
              discordId: event.id, channelId: authorityChannelId,
              ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
              reason: 'handoff-intake-paused', ready
            });
            return this.reject('handoff-intake-paused');
          }
          if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, false, coverageId);
          else this.upsertIntakeWatermark(event, ready, coverageId);
          this.receipt(null, 'intake-rejected', {
            discordId: event.id, channelId: authorityChannelId,
            ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
            reason: 'invalid-event', ready
          });
          return null;
        });
        if (result?.stale) return result;
      }
      return this.reject('invalid-event');
    }
    const isWatcherNotice = Boolean(event.isBot && event.content.startsWith(WATCHER_NOTICE_PREFIX));
    const directPost = isWatcherNotice ? false : this.excludeDirectPost(event);
    return this.transaction(() => {
      const route = this.getMessageRoute(event.channelId);
      const binding = route?.binding || this.getBinding(event.channelId);
      const enrollment = route?.enrollment || null;
      const authorityChannelId = binding?.channelId || event.channelId;
      if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
      const handoffPaused = this.ordinaryHandoffPauses.has(authorityChannelId) ||
        this.getIntakeWatermark(authorityChannelId)?.detail === INTAKE_BOUNDARY_DETAILS.ORDINARY_HANDOFF;
      if (handoffPaused && !enrollment) {
        this.upsertIntakeWatermark(event, false, null);
        this.receipt(null, 'intake-rejected', {
          discordId: event.id, channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason: 'handoff-intake-paused', ready
        });
        return this.reject('handoff-intake-paused');
      }
      if (handoffPaused) {
        ready = false;
        coverageId = null;
      }
      const parentCutoff = route?.handoffCutoffId || null;
      let intakeCutoff = enrollment
        ? enrollment.recoveredThroughId
        : this.getIntakeWatermark(authorityChannelId)?.recovered_through_id || null;
      if (enrollment && parentCutoff && (!intakeCutoff || compareDiscordIds(intakeCutoff, parentCutoff) < 0)) {
        intakeCutoff = parentCutoff;
      }
      if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, false, coverageId);
      else this.upsertIntakeWatermark(event, ready, coverageId);
      let agent = null;
      let invalidAgent = false;
      let notice = null;
      let invalidNotice = false;
      if (event.isBot && event.content.startsWith(AGENT_PREFIX)) {
        try {
          const target = binding && Object.fromEntries(['guildId', 'channelId', 'provider', 'nativeId', 'generation']
            .map(key => [key, key === 'channelId' ? event.channelId : binding[key]]));
          agent = decodeAgentMessage(event.content, agentToken, target);
          if (attachments.length) throw new BindingError('agent attachments are not supported');
        } catch { invalidAgent = true; }
      }
      if (isWatcherNotice) {
        try {
          const target = binding && Object.fromEntries(['guildId', 'channelId', 'provider', 'nativeId', 'generation']
            .map(key => [key, key === 'channelId' ? event.channelId : binding[key]]));
          notice = decodeWatcherNotice(event.content, agentToken, target);
          if (!notice) throw new BindingError('watcher notice is missing');
          watcherNoticeHandlers.authorizeWatcherNoticePublication(this, notice, event);
          if (attachments.length) throw new BindingError('watcher notice attachments are not supported');
        } catch { invalidNotice = true; }
      }
      let reason = invalidAgent || invalidNotice ? 'invalid-event' : null;
      if (typeof event.content !== 'string' || event.content.length > 10000 || attachments === null || (event.content.length === 0 && attachments?.length === 0)) reason = 'invalid-event';
      else if (enrollment && event.isBot && !agent && !notice) reason = 'bot-source';
      else if (!agent && !notice && directPost) reason = 'automatic-publication';
      else if (!agent && !notice && event.isBot) reason = 'bot-source';
      else if (event.guildId !== config.guildId || (!agent && !notice && event.authorId !== config.operatorId)) reason = 'unauthorized-sender';
      if (!reason && (!binding || !binding.active || binding.guildId !== event.guildId)) reason = 'unknown-binding';
      if (!reason && enrollment && [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(enrollment.state)) {
        reason = enrollment.state === THREAD_STATES.GAP ? THREAD_INTAKE_REASONS.GAP : THREAD_INTAKE_REASONS.UNAVAILABLE;
      }
      if (reason) {
        this.receipt(null, 'intake-rejected', {
          discordId: event.id, channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason, ready
        });
        return this.reject(reason);
      }
      const committed = this.getMessage(event.id);
      if (committed) return { accepted: false, duplicate: true, reason: 'duplicate-message', message: committed };
      const cutoffReason = intakeCutoffDecision(event.id, intakeCutoff, compareDiscordIds);
      if (cutoffReason) {
        this.receipt(null, 'intake-rejected', {
          discordId: event.id, channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason: cutoffReason, ready
        });
        return this.reject(cutoffReason);
      }
      if (agent && this.db.prepare(`SELECT 1 FROM receipts WHERE kind='agent-message'
        AND json_extract(detail, '$.packet.id')=?
        AND json_extract(detail, '$.packet.source.guildId')=?
        AND json_extract(detail, '$.packet.source.channelId')=?
        AND json_extract(detail, '$.packet.source.provider')=?
        AND json_extract(detail, '$.packet.source.nativeId')=?
        AND json_extract(detail, '$.packet.source.generation')=?
        AND json_extract(detail, '$.packet.target.guildId')=?
        AND json_extract(detail, '$.packet.target.channelId')=?
        AND json_extract(detail, '$.packet.target.provider')=?
        AND json_extract(detail, '$.packet.target.nativeId')=?
        AND json_extract(detail, '$.packet.target.generation')=? LIMIT 1`)
        .get(agent.id, agent.source.guildId, agent.source.channelId, agent.source.provider, agent.source.nativeId, agent.source.generation,
          agent.target.guildId, agent.target.channelId, agent.target.provider, agent.target.nativeId, agent.target.generation)) {
        this.receipt(null, 'intake-rejected', {
          discordId: event.id,
          channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
          reason: 'agent-message-duplicate',
          ready
        });
        return this.reject('agent-message-duplicate');
      }
      if (notice) {
        const prior = watcherNoticeHandlers.findWatcherNotice(this, notice.armKey, notice.triggerKey);
        if (prior) {
          if (!sameWatcherNotice(prior.provenance.packet, notice)) {
            this.receipt(null, 'intake-rejected', {
              discordId: event.id, channelId: authorityChannelId,
              ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
              reason: 'watcher-notice-identity-conflict', ready
            });
            return this.reject('watcher-notice-identity-conflict');
          }
          this.receipt(null, 'intake-rejected', {
            discordId: event.id, channelId: authorityChannelId,
            ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
            reason: 'watcher-notice-duplicate', ready
          });
          return { accepted: false, duplicate: true, reason: 'watcher-notice-duplicate', message: this.getMessage(prior.messageId) };
        }
      }
      const legacyCorrelatedResult = agent && agent.kind === 'result' && agent.routingVersion === AGENT_ROUTING_VERSION &&
        typeof agent.sourceParentChannelId === 'string' && !enrollment &&
        agent.target.channelId === authorityChannelId &&
        this.db.prepare(`SELECT 1 FROM receipts AS publication
          WHERE kind='direct-post-outcome'
            AND NOT EXISTS (SELECT 1 FROM receipts AS later
              WHERE later.kind='direct-post-outcome' AND later.id>publication.id
                AND json_extract(later.detail, '$.agentPacket.id')=json_extract(publication.detail, '$.agentPacket.id')
                AND json_extract(later.detail, '$.attemptId') IS json_extract(publication.detail, '$.attemptId'))
            AND COALESCE(json_extract(detail, '$.phase'), '')<>'preflight'
            AND json_extract(detail, '$.outcome') IN (?, ?)
            AND json_type(detail, '$.routingVersion') IS NULL
            AND json_type(detail, '$.agentPacket.routingVersion') IS NULL
            AND json_extract(detail, '$.agentPacket.id')=?
            AND json_extract(detail, '$.agentPacket.kind')='request'
            AND json_extract(detail, '$.agentPacket.source.guildId')=?
            AND json_extract(detail, '$.agentPacket.source.channelId')=?
            AND json_extract(detail, '$.agentPacket.source.provider')=?
            AND json_extract(detail, '$.agentPacket.source.nativeId')=?
            AND json_extract(detail, '$.agentPacket.source.generation')=?
            AND json_extract(detail, '$.agentPacket.target.guildId')=?
            AND (json_extract(detail, '$.agentPacket.target.channelId')=? OR json_extract(detail, '$.agentPacket.target.channelId')=?)
            AND json_extract(detail, '$.agentPacket.target.provider')=?
            AND json_extract(detail, '$.agentPacket.target.nativeId')=?
            AND json_extract(detail, '$.agentPacket.target.generation')=?
          LIMIT 1`).get(
            'sent', 'unknown', agent.replyTo,
            agent.target.guildId, agent.target.channelId, agent.target.provider, agent.target.nativeId, agent.target.generation,
            agent.source.guildId, agent.source.channelId, agent.sourceParentChannelId ?? null, agent.source.provider, agent.source.nativeId, agent.source.generation
          );
      if (agent && !enrollment && !legacyCorrelatedResult) {
        this.receipt(null, 'intake-rejected', {
          discordId: event.id, channelId: authorityChannelId,
          reason: 'agent-child-route-required', ready
        });
        return this.reject('agent-child-route-required');
      }
      if (this.failNextIntakeFlag) {
        this.failNextIntakeFlag = false;
        throw new Error('injected intake transaction failure');
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.id, event.guildId, authorityChannelId, event.channelId, event.authorId, event.content, JSON.stringify(attachments), binding.provider, binding.nativeId,
        binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
      );
      if (enrollment) threadEnrollmentHandlers.noteThreadMessage(this, enrollment.threadId, event.id, true);
      else {
        const watermark = this.getIntakeWatermark(authorityChannelId);
        if (!watermark?.last_accepted_id || compareDiscordIds(watermark.last_accepted_id, event.id) < 0) {
          this.db.prepare('UPDATE intake_watermarks SET last_accepted_id=?, updated_at=? WHERE channel_id=?')
            .run(event.id, timestamp, authorityChannelId);
        }
      }
      if (agent) this.receipt(event.id, 'agent-message', { packet: agent, authorId: event.authorId, routingVersion: AGENT_ROUTING_VERSION });
      if (notice) {
        this.receipt(event.id, WATCHER_NOTICE_RECEIPTS.PROVENANCE, {
          journal: WATCHER_NOTICE_JOURNAL, packet: notice, authorId: event.authorId,
          authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY
        });
        this.receipt(event.id, WATCHER_NOTICE_RECEIPTS.PUBLICATION, {
          journal: WATCHER_NOTICE_JOURNAL, packet: notice, authorId: event.authorId,
          noticeId: notice.id, armKey: notice.armKey, triggerKey: notice.triggerKey,
          channelId: authorityChannelId, deliveryChannelId: event.channelId,
          provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation,
          source: WATCHER_NOTICE_PUBLICATION_SOURCE
        });
      }
      this.receipt(event.id, 'accepted', {
        channelId: authorityChannelId,
        ...(enrollment ? { deliveryChannelId: event.channelId } : {}),
        conductorId: binding.conductorId, generation: binding.generation,
        readiness: ready && (!enrollment || enrollment.state === THREAD_STATES.READY) ? 'ready' : 'pending'
      });
      if (!ready || (enrollment && enrollment.state !== THREAD_STATES.READY)) {
        this.receipt(event.id, 'intake-held-not-ready', {
          channelId: authorityChannelId,
          ...(enrollment ? { deliveryChannelId: event.channelId } : {})
        });
      }
      return { accepted: true, message: this.getMessage(event.id) };
    });
  }
  };
}

module.exports = { createMessageIntakeHandlers };
