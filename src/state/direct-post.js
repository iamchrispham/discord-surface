function queryDirectPostRows({ db, assertText, parseJson, StateCorruptError, attemptKind, outcomeKind }, requestId = null, channelId = null) {
  if (requestId !== null) assertText(requestId, 'requestId', 256);
  if (channelId !== null) assertText(channelId, 'channelId', 128);
  const clauses = ['discord_id IS NULL', 'kind IN (?, ?)'];
  const params = [attemptKind, outcomeKind];
  if (requestId !== null) {
    clauses.push("json_extract(detail, '$.requestId')=?");
    params.push(requestId);
  }
  if (channelId !== null) {
    clauses.push("json_extract(detail, '$.channelId')=?");
    params.push(channelId);
  }
  const rows = db.prepare(`SELECT id, kind, detail, created_at FROM receipts
    WHERE ${clauses.join(' AND ')} ORDER BY id`).all(...params);
  return rows.map(row => {
    const detail = parseJson(row.detail, null);
    if (!detail || detail.journal !== 'direct-post-v1') throw new StateCorruptError('direct post receipt is malformed');
    if (detail.inReplyTo === undefined) detail.inReplyTo = null;
    return { id: Number(row.id), kind: row.kind, detail, createdAt: row.created_at };
  });
}

function createDirectPostHandlers({
  BindingError,
  StaleGenerationError,
  StateCorruptError,
  DIRECT_POST_ATTEMPT,
  DIRECT_POST_OUTCOME,
  DIRECT_POST_OUTCOMES,
  assertText,
  bindingMatchesExpected,
  parseJson,
  now
}) {
  return {
    hasUnresolvedOrdinaryPost(state, channelId) {
      const rows = state.directPostRows(null, channelId);
      const outcomes = new Map(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail?.attemptId)
        .map(row => [row.detail.attemptId, row]));
      const requests = new Map();
      for (const row of rows) {
        if (row.kind !== DIRECT_POST_ATTEMPT || row.detail.channelId !== channelId ||
          row.detail.provider !== 'codex' || row.detail.conductorId || row.detail.repoKey) continue;
        const request = requests.get(row.detail.requestId) || new Map();
        request.set(row.detail.partIndex, row);
        requests.set(row.detail.requestId, request);
      }
      for (const parts of requests.values()) {
        let hasFinalPart = false;
        for (const row of parts.values()) {
          const outcome = outcomes.get(row.detail.attemptId);
          if (!outcome || outcome.detail.outcome === 'unknown') return true;
          const partIndex = Number(row.detail.partIndex);
          const partCount = Number(row.detail.partCount);
          if (Number.isInteger(partIndex) && Number.isInteger(partCount) && partIndex === partCount - 1 && outcome.detail.outcome === 'sent') {
            hasFinalPart = true;
          }
        }
        if (!hasFinalPart) return true;
      }
      return false;
    },

    beginDirectPostPart(state, meta) {
      if (!meta || typeof meta !== 'object') throw new BindingError('direct post metadata is required');
      assertText(meta.requestId, 'requestId', 256);
      assertText(meta.attemptId, 'attemptId', 128);
      if (!Number.isInteger(meta.partIndex) || meta.partIndex < 0 || !Number.isInteger(meta.partCount) || meta.partCount < 1 || meta.partIndex >= meta.partCount) {
        throw new BindingError('direct post part index is invalid');
      }
      return state.transaction(() => {
        const rows = state.directPostRows(meta.requestId);
        const identityKeys = ['textHash', 'inReplyTo', 'channelId', 'guildId', 'provider', 'nativeId', 'generation', 'conductorId', 'repoKey', 'partCount'];
        for (const row of rows) {
          for (const key of identityKeys) {
            if (row.detail[key] !== meta[key]) throw new BindingError('direct post request identity conflicts with existing custody');
          }
        }
        if (!state.directPostBindingCurrent(meta.binding, meta.operatorId)) throw new StaleGenerationError('direct post binding is stale');
        const attempts = rows.filter(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.partIndex === meta.partIndex).sort((a, b) => a.id - b.id);
        const outcomes = new Map(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId).map(row => [row.detail.attemptId, row]));
        const latest = attempts.at(-1);
        if (latest) {
          const outcome = outcomes.get(latest.detail.attemptId);
          if (!outcome) return { claimed: false, status: 'in_flight', attemptId: latest.detail.attemptId, nonce: latest.detail.nonce };
          const status = outcome.detail.outcome;
          if (status === 'sent' || status === 'unknown') return { claimed: false, status, attemptId: latest.detail.attemptId, nonce: latest.detail.nonce, outcome: outcome.detail };
          if (!['not_sent', 'rejected', 'rate_limited', 'stale'].includes(status)) return { claimed: false, status, attemptId: latest.detail.attemptId, nonce: latest.detail.nonce, outcome: outcome.detail };
        }
        const ownerIdentity = state.directPostOwnerIdentity(process.pid);
        state.receipt(null, DIRECT_POST_ATTEMPT, {
          journal: 'direct-post-v1', ...meta, ...ownerIdentity, status: 'attempted'
        });
        return { claimed: true, status: 'claimed', attemptId: meta.attemptId, nonce: meta.nonce };
      });
    },

    recordDirectPostOutcome(state, requestId, attemptId, outcome, detail = {}) {
      assertText(requestId, 'requestId', 256);
      assertText(attemptId, 'attemptId', 128);
      if (!DIRECT_POST_OUTCOMES.includes(outcome)) throw new BindingError('invalid direct post outcome');
      return state.transaction(() => {
        const rows = state.directPostRows(requestId);
        const attempt = rows.find(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.attemptId === attemptId);
        if (!attempt) throw new BindingError('direct post attempt is unknown');
        const existing = rows.find(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId === attemptId);
        if (existing) return existing.detail;
        const next = { ...attempt.detail, ...detail, outcome };
        state.receipt(null, DIRECT_POST_OUTCOME, next);
        return next;
      });
    },

    reconcileDirectPostOutcome(state, requestId, attemptId, resolution, evidence = {}) {
      assertText(requestId, 'requestId', 256);
      assertText(attemptId, 'attemptId', 128);
      if (!['sent', 'not_sent'].includes(resolution)) {
        throw new BindingError('direct post reconciliation must resolve to sent or not_sent');
      }
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw new BindingError('direct post reconciliation evidence is required');
      }
      const evidenceText = [evidence.evidenceScope, evidence.scope, evidence.source, evidence.reason, evidence.note,
        evidence.evidence, evidence.messageId, evidence.nonce]
        .find(value => typeof value === 'string' && value.trim().length > 0);
      if (!evidenceText) throw new BindingError('direct post reconciliation evidence is required');
      return state.transaction(() => {
        const rows = state.directPostRows(requestId);
        const attempt = rows.find(row => row.kind === DIRECT_POST_ATTEMPT && row.detail.attemptId === attemptId);
        if (!attempt) throw new BindingError('direct post attempt is unknown');
        const outcomes = rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId === attemptId)
          .sort((left, right) => left.id - right.id);
        const previous = outcomes.at(-1);
        if (!previous || previous.detail.outcome !== 'unknown') {
          throw new BindingError('direct post attempt does not need reconciliation');
        }
        for (const key of ['channelId', 'guildId']) {
          if (evidence[key] !== undefined && evidence[key] !== attempt.detail[key]) {
            throw new BindingError(`direct post reconciliation ${key} does not match the attempt`);
          }
        }
        const next = {
          ...attempt.detail,
          outcome: resolution,
          reconciledFrom: 'unknown',
          reconciliationEvidence: evidence
        };
        if (resolution === 'sent') {
          const messageId = evidence.messageId === undefined ? null : assertText(evidence.messageId, 'messageId', 128);
          const nonce = evidence.nonce === undefined ? null : assertText(evidence.nonce, 'nonce', 256);
          if (!messageId && !nonce) throw new BindingError('sent direct post reconciliation requires a messageId or nonce');
          if (messageId) next.messageId = messageId;
          if (nonce) {
            if (attempt.detail.nonce !== undefined && nonce !== attempt.detail.nonce) {
              throw new BindingError('sent direct post reconciliation nonce does not match the attempt');
            }
            next.nonce = nonce;
          }
        }
        state.receipt(null, DIRECT_POST_OUTCOME, next);
        state.receipt(null, 'direct-post-reconciled', {
          requestId, attemptId, channelId: attempt.detail.channelId, guildId: attempt.detail.guildId,
          outcome: resolution, evidence
        });
        return next;
      });
    },

    directPostOutcomeMatches(state, event, key, value) {
      const jsonPath = { messageId: '$.messageId', nonce: '$.nonce' }[key];
      if (!jsonPath) throw new BindingError('direct post outcome lookup key is invalid');
      const rows = state.db.prepare(`SELECT detail FROM receipts
        WHERE discord_id IS NULL AND kind=?
          AND json_extract(detail, '${jsonPath}')=?
          AND json_extract(detail, '$.channelId')=?
          AND json_extract(detail, '$.guildId')=?`).all(
        DIRECT_POST_OUTCOME, value, event.channelId, event.guildId
      );
      return rows.some(row => {
        const detail = parseJson(row.detail, null);
        if (!detail || detail.journal !== 'direct-post-v1') throw new StateCorruptError('direct post receipt is malformed');
        return detail.outcome === 'sent' && detail[key] === value;
      });
    },

    excludeDirectPost(state, event) {
      if (!event || typeof event.id !== 'string' || typeof event.channelId !== 'string' || typeof event.guildId !== 'string') return false;
      if (this.directPostOutcomeMatches(state, event, 'messageId', event.id)) return true;
      return Boolean(event.isBot && typeof event.nonce === 'string' && this.directPostOutcomeMatches(state, event, 'nonce', event.nonce));
    }
  };
}

module.exports = { createDirectPostHandlers, queryDirectPostRows };
