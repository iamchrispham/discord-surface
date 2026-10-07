'use strict';

function createReadinessHandlers({ parseJson, THREAD_STATES, MESSAGE_STATES, RECOVERY_LIMITS }) {
  function getReadiness() {
    const config = this.getConfig();
    const bindings = this.listBindings();
    const messages = this.listMessages();
    const watermarks = this.listIntakeWatermarks();
    const threadEnrollments = this.listThreadEnrollments();
    const topicCustody = this.listTopicPublications();
    const topicPublications = new Map();
    for (const row of this.listReceipts().filter(item => item.kind === 'topic-publication' || item.kind === 'topic-publication-reconciled')) {
      const detail = parseJson(row.detail, {});
      if (detail.channelId) topicPublications.set(detail.channelId, { ...detail, recordedAt: row.created_at });
    }
    const watermarkGap = watermarks.find(row => row.state === 'gap' || row.state === 'unavailable');
    const watermarkPending = watermarks.some(row => row.state === 'pending');
    const activeThreadGap = threadEnrollments.find(row => row.active && [THREAD_STATES.GAP, THREAD_STATES.UNAVAILABLE].includes(row.state));
    const activeThreadPending = threadEnrollments.some(row => row.active && row.state === THREAD_STATES.PENDING);
    let connectionBackfill = watermarks.length ? 'bounded-by-discord-watermark' : 'pending';
    if (watermarkPending || activeThreadPending) connectionBackfill = 'pending';
    if (activeThreadGap) connectionBackfill = activeThreadGap.state === THREAD_STATES.GAP ? 'unrecoverable-gap' : 'unavailable';
    if (watermarkGap) connectionBackfill = watermarkGap.state === 'gap' ? 'unrecoverable-gap' : 'unavailable';
    return {
      configured: Boolean(config.operatorId && config.guildId && config.secretFile),
      activeBindings: bindings.filter(binding => binding.active).length,
      inactiveBindings: bindings.filter(binding => !binding.active).length,
      pending: messages.filter(message => [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message.state)).length,
      uncertain: messages.filter(message => message.state === MESSAGE_STATES.UNCERTAIN).length,
      unknownDelivery: messages.filter(message => [MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)).length,
      execution: bindings.some(binding => binding.active) ? 'unverified-live' : 'unavailable',
      limits: {
        permission: 'unverified-live',
        nativeApproval: 'unverified-live',
        quota: 'unverified-live',
        billing: 'unverified-live',
        connectionBackfill,
        recovery: RECOVERY_LIMITS
      },
      intakeWatermarks: watermarks.map(row => ({ channelId: row.channel_id, lastSeenId: row.last_seen_id, recoveredThroughId: row.recovered_through_id, state: row.state, gapFrom: row.gap_from, gapTo: row.gap_to, detail: row.detail })),
      threadEnrollments,
      legacyTopicPublications: [...topicPublications.values()],
      legacyTopicPublicationCustody: topicCustody
    };
  }
  return { getReadiness };
}

module.exports = { createReadinessHandlers };
