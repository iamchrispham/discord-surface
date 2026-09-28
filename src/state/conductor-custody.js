'use strict';

// Issue132 conductor-custody companion. Owns accepted-human custody eligibility,
// deterministic snapshot construction, snapshot-vs-live comparison, and transfer
// evidence construction. src/state.js keeps SurfaceState.handoffConductor as the
// transaction facade and calls into this module. This file never requires
// ./state, so there is no circular import.

const TRANSFER_RECEIPT_KIND = 'conductor-custody-transferred';

// Deny-by-default control-plane vocabulary. Only these receipt kinds may appear
// on a message whose custody is being carried to a successor. Any kind absent
// from this list — including a kind a future producer adds — refuses the whole
// operation instead of being treated as harmless history.
const CUSTODY_RECEIPT_KINDS = Object.freeze({
  ACCEPTED: 'accepted',
  INTAKE_HELD_NOT_READY: 'intake-held-not-ready',
  DISPATCH_HELD_NOT_READY: 'dispatch-held-not-ready',
  TRANSPORT_ATTEMPT: 'transport-receipt-attempt',
  TRANSPORT_OUTCOME: 'transport-receipt-outcome',
  TRANSFERRED: TRANSFER_RECEIPT_KIND
});

const CUSTODY_RECEIPT_ALLOWLIST = Object.freeze([
  CUSTODY_RECEIPT_KINDS.ACCEPTED,
  CUSTODY_RECEIPT_KINDS.INTAKE_HELD_NOT_READY,
  CUSTODY_RECEIPT_KINDS.DISPATCH_HELD_NOT_READY,
  CUSTODY_RECEIPT_KINDS.TRANSPORT_ATTEMPT,
  CUSTODY_RECEIPT_KINDS.TRANSPORT_OUTCOME
]);

const TRANSPORT_RECEIPT_KINDS = new Set([
  CUSTODY_RECEIPT_KINDS.TRANSPORT_ATTEMPT,
  CUSTODY_RECEIPT_KINDS.TRANSPORT_OUTCOME
]);

const EVIDENCE_KEYS = Object.freeze(['messages', 'receipts', 'replyParts', 'enrollments', 'publications']);

function parseStrict(detail) {
  if (typeof detail !== 'string') return null;
  try {
    const parsed = JSON.parse(detail);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function createConductorCustodyHandlers({
  ACTIVE_STATES,
  MESSAGE_STATES,
  BindingError,
  StaleGenerationError,
  UnresolvedWorkError,
  now
}) {
  const refuse = () => { throw new UnresolvedWorkError('cannot handoff while work is unresolved'); };

  // Same query shape for both the snapshot and the in-transaction re-read. Every
  // value is a bound parameter; nothing is string-interpolated.
  function readChannelEvidence(state, channelId) {
    return {
      messages: state.db.prepare('SELECT * FROM messages WHERE channel_id=? ORDER BY rowid').all(channelId),
      receipts: state.db.prepare(`SELECT r.* FROM receipts r
        JOIN messages m ON m.discord_id=r.discord_id
        WHERE m.channel_id=? ORDER BY r.id`).all(channelId),
      replyParts: state.db.prepare(`SELECT p.* FROM reply_parts p
        JOIN messages m ON m.discord_id=p.discord_id
        WHERE m.channel_id=? ORDER BY p.discord_id, p.part_index`).all(channelId),
      enrollments: state.db.prepare('SELECT * FROM thread_enrollments WHERE parent_channel_id=? ORDER BY thread_id').all(channelId),
      publications: state.db.prepare('SELECT * FROM topic_publications WHERE channel_id=? ORDER BY request_id').all(channelId)
    };
  }

  // ordinaryBindingHandlers.advanceEnrolledThreadCutoffs legitimately rewrites
  // these two columns inside the handoff transaction; every other enrollment
  // column is compared value-for-value, so an external change still refuses.
  function projectEnrollment(row) {
    const projected = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'recovered_through_id' || key === 'updated_at') continue;
      projected[key] = value;
    }
    return projected;
  }

  function serializeEvidence(evidence) {
    return {
      messages: JSON.stringify(evidence.messages),
      receipts: JSON.stringify(evidence.receipts),
      replyParts: JSON.stringify(evidence.replyParts),
      enrollments: JSON.stringify(evidence.enrollments.map(projectEnrollment)),
      publications: JSON.stringify(evidence.publications)
    };
  }

  function sameIdentity(left, right) {
    return (left ?? null) === (right ?? null);
  }

  function tupleMatches(row, request, binding) {
    return row.guild_id === binding.guildId &&
      row.channel_id === request.channelId &&
      row.provider === request.provider &&
      row.native_id === request.fromNativeId &&
      Number(row.generation) === request.fromGeneration &&
      sameIdentity(row.conductor_id, request.conductorId) &&
      sameIdentity(row.repo_key, request.repoKey) &&
      // The source tuple is the live predecessor binding. request.workspace /
      // request.endpoint are the successor target, which may legitimately differ
      // (new workspace or socket) without making the candidate attempted.
      sameIdentity(row.workspace, binding.workspace) &&
      sameIdentity(row.endpoint, binding.endpoint);
  }

  function sourceIdentityStale(binding, request) {
    return binding.provider !== request.provider ||
      !sameIdentity(binding.conductorId, request.conductorId) ||
      !sameIdentity(binding.repoKey, request.repoKey) ||
      binding.nativeId !== request.fromNativeId ||
      binding.generation !== request.fromGeneration;
  }

  function assertChannelCustodySettled(state, request) {
    if (state.hasUnresolvedTopicPublication(request.channelId)) refuse();
    if (state.hasUnresolvedBindingPost(request.channelId)) refuse();
    const pendingDecision = state.listDecisionPendingWork().some(click =>
      click.channelId === request.channelId && !state.getMessage(click.interactionId)?.decisionResult);
    if (pendingDecision) refuse();
  }

  function validateCandidateReceipts(state, receiptRows, messageRow, request) {
    let accepted = null;
    const transfers = [];
    for (const row of receiptRows) {
      if (row.kind === CUSTODY_RECEIPT_KINDS.TRANSFERRED) {
        const detail = parseStrict(row.detail);
        if (!detail) refuse();
        transfers.push({ id: row.id, detail });
        continue;
      }
      if (!CUSTODY_RECEIPT_ALLOWLIST.includes(row.kind)) refuse();
      const detail = parseStrict(row.detail);
      if (!detail) refuse();
      // A non-null transport discriminator marks an interaction callback, which is
      // not ordinary human work, even though the receipt kind itself is allowed.
      if (TRANSPORT_RECEIPT_KINDS.has(row.kind) && detail.transport != null) refuse();
      if (row.kind === CUSTODY_RECEIPT_KINDS.ACCEPTED) {
        if (accepted) refuse();
        accepted = { id: row.id, detail };
      }
    }
    if (!accepted) refuse();
    return { accepted, transfers };
  }

  function validateAcceptedReceipt(messageRow, accepted, request, originalGeneration) {
    const detail = accepted.detail;
    if (detail.channelId != null && detail.channelId !== messageRow.channel_id) refuse();
    if (detail.conductorId != null && !sameIdentity(detail.conductorId, request.conductorId)) refuse();
    if (detail.generation != null && Number(detail.generation) !== originalGeneration) refuse();
    const delivery = messageRow.delivery_channel_id || messageRow.channel_id;
    if (detail.deliveryChannelId != null && detail.deliveryChannelId !== delivery) refuse();
  }

  // A prior conductor-custody-transferred chain lets a second successor take over
  // before any dispatch happened. Every hop must be contiguous and independently
  // resolvable through the existing conductor-handoff journal; the original
  // accepted receipt is never rewritten.
  function validateTransferChain(state, transfers, messageRow, request, originalGeneration) {
    let previous = null;
    for (const { detail } of transfers) {
      if (typeof detail.handoffId !== 'string' || detail.handoffId.length === 0) refuse();
      if (typeof detail.fromNativeId !== 'string' || typeof detail.nativeId !== 'string') refuse();
      if (!Number.isInteger(detail.fromGeneration) || !Number.isInteger(detail.generation)) refuse();
      if (detail.generation !== detail.fromGeneration + 1) refuse();
      if (previous === null) {
        if (detail.fromGeneration !== originalGeneration) refuse();
      } else if (detail.fromNativeId !== previous.nativeId || detail.fromGeneration !== previous.generation) {
        refuse();
      }
      const handoff = state.findConductorHandoff(detail.handoffId);
      if (!handoff) refuse();
      if (handoff.channelId !== request.channelId || handoff.provider !== request.provider ||
        !sameIdentity(handoff.conductorId, request.conductorId) || !sameIdentity(handoff.repoKey, request.repoKey)) {
        refuse();
      }
      if (handoff.fromNativeId !== detail.fromNativeId || handoff.fromGeneration !== detail.fromGeneration ||
        handoff.nativeId !== detail.nativeId || handoff.generation !== detail.generation) {
        refuse();
      }
      previous = { nativeId: detail.nativeId, generation: detail.generation };
    }
    if (previous === null) {
      if (Number(messageRow.generation) !== originalGeneration) refuse();
    } else if (messageRow.native_id !== previous.nativeId || Number(messageRow.generation) !== previous.generation) {
      refuse();
    }
  }

  function eligibleCandidate(state, row, request, binding, evidence, config) {
    if (row.state !== MESSAGE_STATES.ACCEPTED) refuse();
    if (row.author_id !== config.operatorId) refuse();
    if (!tupleMatches(row, request, binding)) refuse();
    if (row.reply_text != null || row.reply_nonce != null || row.reply_message_id != null) refuse();
    if (Number(row.reply_next_part || 0) !== 0) refuse();
    // Inspect the raw nullable observer columns directly: parseJson would fold
    // malformed data into null and silently read as absent.
    if (row.observer_cursor != null || row.observer_marker != null) refuse();
    if (row.error != null) refuse();
    const partCount = Number(state.db.prepare('SELECT COUNT(*) AS count FROM reply_parts WHERE discord_id=?').get(row.discord_id).count);
    if (partCount > 0) refuse();
    const receiptRows = evidence.receipts.filter(item => item.discord_id === row.discord_id);
    const { accepted, transfers } = validateCandidateReceipts(state, receiptRows, row, request);
    const originalGeneration = Number(accepted.detail.generation);
    if (!Number.isInteger(originalGeneration) || originalGeneration < 1) refuse();
    validateAcceptedReceipt(row, accepted, request, originalGeneration);
    validateTransferChain(state, transfers, row, request, originalGeneration);
    const delivery = row.delivery_channel_id || row.channel_id;
    if (delivery !== row.channel_id) {
      const enrollment = evidence.enrollments.find(item =>
        item.thread_id === delivery && item.parent_channel_id === row.channel_id && Number(item.active) === 1);
      if (!enrollment) refuse();
    }
    return { discordId: row.discord_id, nativeId: row.native_id, generation: Number(row.generation), deliveryChannelId: delivery };
  }

  function snapshotEligibleCustody(state, request) {
    const config = state.requireConfig();
    const binding = state.getBinding(request.channelId);
    if (!binding || !binding.active || sourceIdentityStale(binding, request)) {
      throw new StaleGenerationError('handoff source identity is stale');
    }
    assertChannelCustodySettled(state, request);
    const evidence = readChannelEvidence(state, request.channelId);
    const candidates = [];
    for (const row of evidence.messages) {
      if (!ACTIVE_STATES.has(row.state)) continue;
      candidates.push(eligibleCandidate(state, row, request, binding, evidence, config));
    }
    return {
      channelId: request.channelId,
      expectedGeneration: request.expectedGeneration,
      serialized: serializeEvidence(evidence),
      candidates
    };
  }

  function verifySnapshotAndTransfer(state, snapshot, request, updatedAt) {
    if (!snapshot || snapshot.channelId !== request.channelId) refuse();
    const current = state.getBinding(request.channelId);
    if (!current || !current.active ||
      current.provider !== request.provider ||
      !sameIdentity(current.conductorId, request.conductorId) ||
      !sameIdentity(current.repoKey, request.repoKey) ||
      current.nativeId !== request.nativeId ||
      current.generation !== snapshot.expectedGeneration ||
      !sameIdentity(current.workspace, request.workspace) ||
      !sameIdentity(current.endpoint, request.endpoint)) {
      throw new StaleGenerationError('conductor custody transfer target changed');
    }
    assertChannelCustodySettled(state, request);
    const live = serializeEvidence(readChannelEvidence(state, request.channelId));
    for (const key of EVIDENCE_KEYS) {
      if (live[key] !== snapshot.serialized[key]) refuse();
    }
    const stamp = updatedAt || now();
    for (const candidate of snapshot.candidates) {
      const result = state.db.prepare(`UPDATE messages
        SET native_id=?, generation=?, workspace=?, endpoint=?, updated_at=?
        WHERE discord_id=? AND state=? AND native_id=? AND generation=? AND provider=? AND conductor_id=? AND repo_key=?`)
        .run(request.nativeId, snapshot.expectedGeneration, request.workspace, request.endpoint, stamp,
          candidate.discordId, MESSAGE_STATES.ACCEPTED, candidate.nativeId, candidate.generation,
          request.provider, request.conductorId, request.repoKey);
      if (Number(result.changes) !== 1) throw new StaleGenerationError('conductor custody transfer target changed');
      // The message row update and receipt append happen per message, in that
      // order, inside the one existing handoffConductor transaction.
      state.receipt(candidate.discordId, TRANSFER_RECEIPT_KIND, transferDetail(request, candidate, snapshot));
    }
    return snapshot.candidates.length;
  }

  function transferDetail(request, candidate, snapshot) {
    const detail = {
      channelId: request.channelId,
      provider: request.provider,
      conductorId: request.conductorId,
      repoKey: request.repoKey,
      handoffId: request.handoffId,
      fromNativeId: candidate.nativeId,
      fromGeneration: candidate.generation,
      nativeId: request.nativeId,
      generation: snapshot.expectedGeneration
    };
    if (candidate.deliveryChannelId && candidate.deliveryChannelId !== request.channelId) {
      detail.deliveryChannelId = candidate.deliveryChannelId;
    }
    return detail;
  }

  return {
    TRANSFER_RECEIPT_KIND,
    CUSTODY_RECEIPT_KINDS,
    CUSTODY_RECEIPT_ALLOWLIST,
    snapshotEligibleCustody,
    verifySnapshotAndTransfer,
    transferDetail
  };
}

module.exports = {
  createConductorCustodyHandlers,
  TRANSFER_RECEIPT_KIND,
  CUSTODY_RECEIPT_KINDS,
  CUSTODY_RECEIPT_ALLOWLIST
};
