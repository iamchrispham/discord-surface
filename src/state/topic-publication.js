const crypto = require('node:crypto');
const TOPIC_DEFINITE_NOT_PUBLISHED = new Set(['rate_limited', 'rejected', 'stopped', 'not_published']);

function rowTopicPublication(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    channelId: row.channel_id,
    guildId: row.guild_id,
    provider: row.provider,
    nativeId: row.native_id,
    conductorId: row.conductor_id || null,
    repoKey: row.repo_key || null,
    generation: Number(row.generation),
    desiredReadiness: row.desired_readiness,
    desiredTopic: row.desired_topic,
    status: row.status,
    outcome: row.outcome || null,
    evidenceScope: row.evidence_scope || null,
    error: row.error || null,
    operationEndedAt: row.operation_ended_at || null,
    readbackAt: row.readback_at || null,
    readbackTopic: row.readback_topic || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function bindingIdentityMatchesTopicPublication(binding, publication) {
  return Boolean(binding?.active) && binding.channelId === publication.channelId && binding.guildId === publication.guildId &&
    binding.provider === publication.provider && binding.nativeId === publication.nativeId &&
    binding.generation === publication.generation && binding.conductorId === publication.conductorId &&
    binding.repoKey === publication.repoKey;
}

function createTopicPublicationHandlers({ assertText, BindingError, UnresolvedWorkError, StaleGenerationError, READINESS, TOPIC_PUBLICATION_STATES, bindingMatchesExpected, now }) {
  return {
    listTopicPublications(channelId = null) {
    if (channelId !== null) assertText(channelId, 'channelId', 128);
    const rows = channelId === null
      ? this.db.prepare('SELECT * FROM topic_publications ORDER BY updated_at, request_id').all()
      : this.db.prepare('SELECT * FROM topic_publications WHERE channel_id=? ORDER BY updated_at, request_id').all(channelId);
    return rows.map(rowTopicPublication);
  },

    getTopicPublication(requestId) {
    assertText(requestId, 'requestId', 128);
    return rowTopicPublication(this.db.prepare('SELECT * FROM topic_publications WHERE request_id=?').get(requestId));
  },

    hasUnresolvedTopicPublication(channelId) {
    assertText(channelId, 'channelId', 128);
    return Boolean(this.db.prepare("SELECT 1 FROM topic_publications WHERE channel_id=? AND status IN ('in_flight', 'unknown') LIMIT 1").get(channelId));
  },

    assertTopicPublicationSettled(channelId) {
    if (this.hasUnresolvedTopicPublication(channelId)) throw new UnresolvedWorkError('topic publication custody is unresolved');
  },

    assertLegacyMigrationSafe(channelId) {
    assertText(channelId, 'channelId', 128);
    this.assertTopicPublicationSettled(channelId);
    return true;
  },

    beginTopicPublication(channelId, publication, expectedBinding) {
    assertText(channelId, 'channelId', 128);
    if (!expectedBinding) throw new BindingError('topic publication requires an expected binding identity');
    if (!publication || typeof publication.desiredReadiness !== 'string') throw new BindingError('topic publication readiness is required');
    if (!Object.values(READINESS).includes(publication.desiredReadiness)) throw new BindingError('invalid topic publication readiness');
    assertText(publication.desiredTopic, 'desiredTopic', 1024);
    const publishedAt = publication.publishedAt == null ? null : assertText(publication.publishedAt, 'publishedAt', 64);
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      this.assertTopicPublicationSettled(channelId);
      const requestId = crypto.randomUUID();
      const timestamp = now();
      this.db.prepare(`INSERT INTO topic_publications(
        request_id, channel_id, guild_id, provider, native_id, conductor_id, repo_key, generation,
        desired_readiness, desired_topic, status, outcome, evidence_scope, error, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`).run(
        requestId, channelId, binding.guildId, binding.provider, binding.nativeId, binding.conductorId, binding.repoKey,
        binding.generation, publication.desiredReadiness, publication.desiredTopic, TOPIC_PUBLICATION_STATES.IN_FLIGHT,
        timestamp, timestamp
      );
      const guardedReadiness = publication.desiredReadiness === READINESS.READY ? READINESS.UNAVAILABLE : publication.desiredReadiness;
      this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=? AND active=1').run(guardedReadiness, timestamp, channelId);
      if (publication.desiredReadiness === READINESS.READY) {
        this.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, updated_at=? WHERE channel_id=? AND state <> 'gap'")
          .run('Discord topic publication custody is unresolved', timestamp, channelId);
      }
      this.receipt(null, 'topic-publication-started', {
        requestId, channelId, conductorId: binding.conductorId, repoKey: binding.repoKey,
        provider: binding.provider, nativeId: binding.nativeId, generation: binding.generation,
        desiredReadiness: publication.desiredReadiness, desiredTopic: publication.desiredTopic, publishedAt
      });
      return this.getTopicPublication(requestId);
    });
  },

    recordTopicPublication(channelId, publication, expectedBinding = null) {
    assertText(channelId, 'channelId', 128);
    if (!publication || typeof publication.desiredReadiness !== 'string') throw new BindingError('topic publication readiness is required');
    if (!Object.values(READINESS).includes(publication.desiredReadiness)) throw new BindingError('invalid topic publication readiness');
    const requestId = publication.requestId == null ? null : assertText(publication.requestId, 'requestId', 128);
    const outcome = String(publication.outcome || 'unknown');
    const remoteTerminal = publication.remoteTerminal === true;
    const status = remoteTerminal && outcome === 'published'
      ? TOPIC_PUBLICATION_STATES.PUBLISHED
      : remoteTerminal && TOPIC_DEFINITE_NOT_PUBLISHED.has(outcome) && publication.publicationUnknown !== true
        ? TOPIC_PUBLICATION_STATES.NOT_PUBLISHED
        : TOPIC_PUBLICATION_STATES.UNKNOWN;
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      const custody = requestId ? this.getTopicPublication(requestId) : null;
      if (requestId && (!custody || custody.channelId !== channelId)) throw new BindingError('topic publication custody is unknown');
      if (custody && ![TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN].includes(custody.status)) return binding;
      if (custody && custody.status === TOPIC_PUBLICATION_STATES.UNKNOWN && !remoteTerminal) return binding;
      if (custody && !bindingIdentityMatchesTopicPublication(binding, custody)) {
        const settledAt = remoteTerminal ? now() : null;
        this.db.prepare('UPDATE topic_publications SET status=?, outcome=?, error=?, operation_ended_at=COALESCE(operation_ended_at, ?), updated_at=? WHERE request_id=? AND status IN (?, ?)')
          .run(TOPIC_PUBLICATION_STATES.UNKNOWN, 'stale', 'topic publication owner changed before settlement', settledAt, now(), requestId, TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN);
        this.receipt(null, 'topic-publication', {
          requestId, channelId, conductorId: custody.conductorId, repoKey: custody.repoKey,
          provider: custody.provider, nativeId: custody.nativeId, generation: custody.generation,
          desiredReadiness: custody.desiredReadiness, publishedReadiness: null, publishedAt: null,
          outcome: 'stale', custodyStatus: TOPIC_PUBLICATION_STATES.UNKNOWN,
          remoteTerminal,
          observedTopic: typeof publication.observedTopic === 'string' ? publication.observedTopic : null,
          error: 'topic publication owner changed before settlement'
        });
        return null;
      }
      const desiredReadiness = custody?.desiredReadiness || publication.desiredReadiness;
      if (custody) {
        const endedAt = remoteTerminal ? (custody.operationEndedAt || now()) : custody.operationEndedAt;
        this.db.prepare(`UPDATE topic_publications SET status=?, outcome=?, error=?, operation_ended_at=?, updated_at=? WHERE request_id=? AND status IN (?, ?)`)
          .run(status, outcome, publication.error ? String(publication.error).slice(0, 200) : null, endedAt, now(), requestId, TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN);
      }
      this.receipt(null, 'topic-publication', {
        requestId, channelId,
        conductorId: custody?.conductorId || binding?.conductorId || null,
        repoKey: custody?.repoKey || binding?.repoKey || null,
        provider: custody?.provider || binding?.provider || null,
        nativeId: custody?.nativeId || binding?.nativeId || null,
        generation: custody?.generation || binding?.generation || null,
        desiredReadiness,
        publishedReadiness: publication.publishedReadiness || null,
        publishedAt: publication.publishedAt || null,
        outcome,
        custodyStatus: status,
        remoteTerminal,
        observedTopic: typeof publication.observedTopic === 'string' ? publication.observedTopic : null,
        error: publication.error ? String(publication.error).slice(0, 200) : null
      });
      return this.getBinding(channelId);
    });
  },

    reconcileTopicPublication(channelId, requestId, resolution, evidenceScope, readback = null) {
    assertText(channelId, 'channelId', 128);
    assertText(requestId, 'requestId', 128);
    if (!['published', 'not_published'].includes(resolution)) throw new BindingError('topic publication resolution must be published or not_published');
    assertText(evidenceScope, 'evidenceScope', 2000);
    if (!readback || typeof readback !== 'object') throw new BindingError('fresh topic readback is required');
    assertText(readback.topic, 'readback.topic', 2048);
    assertText(readback.observedAt, 'readback.observedAt', 64);
    if (!Number.isFinite(Date.parse(readback.observedAt))) throw new BindingError('readback.observedAt must be an ISO timestamp');
    return this.transaction(() => {
      const custody = this.getTopicPublication(requestId);
      if (!custody || custody.channelId !== channelId) throw new BindingError('topic publication custody is unknown');
      if (![TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN].includes(custody.status)) {
        throw new BindingError('topic publication custody is already settled');
      }
      if (!custody.operationEndedAt) throw new UnresolvedWorkError('topic publication operation has not terminated');
      if (Date.parse(readback.observedAt) < Date.parse(custody.operationEndedAt)) throw new BindingError('topic readback predates operation termination');
      if (resolution === 'published' && readback.topic !== custody.desiredTopic) throw new BindingError('topic readback does not confirm the desired publication');
      if (resolution === 'not_published' && readback.topic === custody.desiredTopic) throw new BindingError('topic readback confirms the desired publication');
      const binding = this.getBinding(channelId);
      if (!binding || !bindingIdentityMatchesTopicPublication(binding, custody)) throw new StaleGenerationError('topic publication reconciliation target is stale');
      const status = resolution === 'published' ? TOPIC_PUBLICATION_STATES.PUBLISHED : TOPIC_PUBLICATION_STATES.NOT_PUBLISHED;
      const outcome = resolution === 'published' ? 'reconciled_published' : 'reconciled_not_published';
      this.db.prepare('UPDATE topic_publications SET status=?, outcome=?, evidence_scope=?, error=NULL, readback_at=?, readback_topic=?, updated_at=? WHERE request_id=? AND status IN (?, ?)')
        .run(status, outcome, evidenceScope, readback.observedAt, readback.topic, now(), requestId, TOPIC_PUBLICATION_STATES.IN_FLIGHT, TOPIC_PUBLICATION_STATES.UNKNOWN);
      this.receipt(null, 'topic-publication-reconciled', {
        requestId, channelId, provider: custody.provider, nativeId: custody.nativeId,
        conductorId: custody.conductorId, repoKey: custody.repoKey, generation: custody.generation,
        desiredReadiness: custody.desiredReadiness, resolution, evidenceScope, custodyStatus: status,
        operationEndedAt: custody.operationEndedAt, readbackAt: readback.observedAt, readbackTopic: readback.topic
      });
      return this.getBinding(channelId);
    });
  },

    recoverTopicPublications() {
      const topicPublications = this.db.prepare('SELECT * FROM topic_publications WHERE status=?').all(TOPIC_PUBLICATION_STATES.IN_FLIGHT);
      for (const row of topicPublications) {
        this.db.prepare('UPDATE topic_publications SET status=?, outcome=?, error=?, updated_at=? WHERE request_id=? AND status=?')
          .run(TOPIC_PUBLICATION_STATES.UNKNOWN, 'process_stopped', 'process stopped during topic publication', now(), row.request_id, TOPIC_PUBLICATION_STATES.IN_FLIGHT);
        this.receipt(null, 'topic-publication-unknown-after-restart', {
          requestId: row.request_id, channelId: row.channel_id, provider: row.provider,
          nativeId: row.native_id, conductorId: row.conductor_id, repoKey: row.repo_key,
          generation: row.generation, desiredReadiness: row.desired_readiness
        });
      }
    }
  };
}

module.exports = { createTopicPublicationHandlers };
