'use strict';

const path = require('node:path');

function createBindingLifecycleHandlers({
  ADOPTION_REFUSAL_DETAILS,
  BindingError,
  ORDINARY_RECEIPT_KINDS,
  PROVIDERS,
  READINESS,
  StaleGenerationError,
  UnresolvedWorkError,
  assertConductorId,
  assertEndpoint,
  assertOrdinaryIdentity,
  assertOrdinaryNativeIdentity,
  assertProvider,
  assertRepoKey,
  assertText,
  assertUuid,
  bindingMatchesExpected,
  conductorCustodyHandlers,
  now,
  ordinaryBindingHandlers,
  parseJson,
  persistenceRefusal,
  qualifiedCoverageId,
  rowBinding,
  threadEnrollmentHandlers
}) {
  function bindingInput(binding, existing = null) {
      const channelId = assertText(binding.channelId, 'channelId', 128);
      const guildId = binding.guildId == null && existing ? existing.guildId : assertText(binding.guildId, 'guildId', 128);
      const provider = assertProvider(binding.provider);
      const nativeId = assertUuid(binding.nativeId);
      const workspace = assertText(binding.workspace, 'workspace', 4096);
      if (!path.isAbsolute(workspace)) throw new BindingError('workspace must be absolute');
      let sessionRoot;
      if (binding.sessionRoot === undefined) sessionRoot = existing?.sessionRoot || null;
      else if (binding.sessionRoot === null) sessionRoot = null;
      else sessionRoot = assertText(binding.sessionRoot, 'sessionRoot', 4096);
      if (sessionRoot !== null && !path.isAbsolute(sessionRoot)) throw new BindingError('sessionRoot must be absolute');
      const endpoint = binding.endpoint == null ? null : assertEndpoint(binding.endpoint);
      if (provider === PROVIDERS.CLAUDE && !endpoint) throw new BindingError('Claude bindings require a channel endpoint');
      const categoryId = binding.categoryId == null ? (existing?.categoryId || null) : assertText(binding.categoryId, 'categoryId', 128);
      const conductorId = binding.conductorId == null ? (existing?.conductorId || null) : assertConductorId(binding.conductorId);
      const repoKey = binding.repoKey == null ? (existing?.repoKey || null) : assertRepoKey(binding.repoKey);
      if (Boolean(conductorId) !== Boolean(repoKey)) throw new BindingError('conductorId and repoKey must be provided together');
      const generation = binding.generation == null ? null : Number(binding.generation);
      if (generation !== null && (!Number.isInteger(generation) || generation < 1)) throw new BindingError('generation must be a positive integer');
      const readiness = binding.readiness == null ? (existing?.readiness || (conductorId ? READINESS.PENDING : READINESS.READY)) : binding.readiness;
      if (!Object.values(READINESS).includes(readiness)) throw new BindingError('invalid binding readiness');
      const config = this.requireConfig();
      if (guildId !== config.guildId) throw new BindingError('binding guild is not the configured guild');
      return { channelId, guildId, provider, nativeId, workspace, sessionRoot, endpoint, categoryId, conductorId, repoKey, readiness, generation };
    }

  function bind(binding, options = {}) {
      const ordinaryIdentity = binding.ordinaryIdentity || null;
      const intakeCutoff = options.intakeCutoff ?? null;
      const intakeCutoffDetail = options.intakeCutoffDetail || null;
      const beforeMutation = options.beforeMutation;
      const input = this.bindingInput(binding);
      if (ordinaryIdentity) {
        if (input.conductorId || input.repoKey) throw new BindingError(`ordinary ${input.provider} bindings cannot carry conductor identity`);
        assertOrdinaryIdentity(input.provider, ordinaryIdentity);
        assertOrdinaryNativeIdentity(input.provider, input.nativeId, ordinaryIdentity);
      }
      const existing = this.getBinding(input.channelId);
      if (existing) throw new BindingError('channel is already bound; use rebind after work drains');
      if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(input.channelId)) {
        throw new BindingError('thread channel is already enrolled');
      }
      this.assertNativeOwnerFree(input.provider, input.nativeId);
      this.assertConductorOwnerFree(input.provider, input.conductorId);
      // A genuinely fresh public binding must acquire an explicit permission-qualified
      // history boundary before its active row is inserted. Reuse/identity-conflict
      // diagnoses above run first; this gates only the fresh activation below.
      if (!qualifiedCoverageId(intakeCutoff)) throw persistenceRefusal(BindingError, ADOPTION_REFUSAL_DETAILS.PARENT_CUTOFF);
      const createdAt = now();
      return this.transaction(() => {
        if (this.getBinding(input.channelId)) throw new BindingError('channel is already bound; use rebind after work drains');
        if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(input.channelId)) {
          throw new BindingError('thread channel is already enrolled');
        }
        this.assertNativeOwnerFree(input.provider, input.nativeId);
        if (!qualifiedCoverageId(intakeCutoff)) throw persistenceRefusal(BindingError, ADOPTION_REFUSAL_DETAILS.PARENT_CUTOFF);
        const generationRow = input.conductorId
          ? this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE provider=? AND conductor_id=?').get(input.provider, input.conductorId)
          : this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS next FROM bindings WHERE channel_id=?').get(input.channelId);
        const nextGeneration = Number(generationRow.next);
        const generation = input.generation == null ? nextGeneration : input.generation;
        if (generation < nextGeneration) throw new BindingError('binding generation would move backwards');
        if (typeof beforeMutation === 'function') beforeMutation();
        this.db.prepare(`INSERT INTO bindings(channel_id, guild_id, provider, native_id, workspace, session_root, endpoint, category_id, conductor_id, repo_key, readiness, generation, active, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(input.channelId, input.guildId, input.provider, input.nativeId, input.workspace, input.sessionRoot, input.endpoint, input.categoryId, input.conductorId, input.repoKey, input.readiness, generation, createdAt);
        this.receipt(null, 'bound', { channelId: input.channelId, provider: input.provider, conductorId: input.conductorId, generation });
        if (ordinaryIdentity) {
          this.receipt(null, ORDINARY_RECEIPT_KINDS.BOUND, {
            channelId: input.channelId, guildId: input.guildId, provider: input.provider,
            nativeId: input.nativeId, workspace: input.workspace, generation,
            sessionRoot: input.sessionRoot,
            sessionId: ordinaryIdentity.sessionId, threadId: ordinaryIdentity.threadId,
            harness: ordinaryIdentity.harness || undefined, endpoint: input.endpoint || undefined
          });
        }
        this.setIntakeCutoffInTransaction(input.channelId, input.guildId, intakeCutoff, intakeCutoffDetail);
        return this.getBinding(input.channelId);
      });
    }

  function rebind(binding, {
      resetIntake = false,
      sessionRootOverride = undefined,
      intakeCutoff = null,
      enrollmentProof = null,
      beforeMutation = undefined
    } = {}) {
      if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
      const channelId = assertText(binding.channelId, 'channelId', 128);
      if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(channelId)) {
        throw new BindingError('thread channel is already enrolled');
      }
      const existing = this.getBinding(channelId);
      if (!existing) throw new BindingError('channel is not bound');
      if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot rebind while work drains');
      if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
        throw new BindingError('active thread enrollments require an observed intake cutoff');
      }
      const ordinaryIdentity = binding.ordinaryIdentity || null;
      if (ordinaryIdentity) {
        if (binding.conductorId || binding.repoKey) throw new BindingError(`ordinary ${binding.provider} bindings cannot carry conductor identity`);
        assertOrdinaryIdentity(binding.provider, ordinaryIdentity);
      }
      const input = this.bindingInput({ ...binding, channelId }, existing);
      if (sessionRootOverride !== undefined) input.sessionRoot = sessionRootOverride;
      const ordinary = this._isOrdinaryBindingRecord(existing);
      const ordinaryIdentityMatches = input.nativeId === existing.nativeId &&
        ordinaryIdentity?.sessionId === existing.nativeId && ordinaryIdentity?.threadId === existing.nativeId;
      if (ordinary && existing.provider === PROVIDERS.CODEX && (!ordinaryIdentity || input.provider !== PROVIDERS.CODEX || input.conductorId || input.repoKey ||
        !ordinaryIdentityMatches)) {
        throw new BindingError('ordinary bindings require matching invocation identity');
      }
      if (ordinary && existing.provider === PROVIDERS.CLAUDE && (!ordinaryIdentity || input.provider !== PROVIDERS.CLAUDE || input.conductorId || input.repoKey ||
        input.nativeId !== existing.nativeId || input.workspace !== existing.workspace || input.endpoint !== existing.endpoint ||
        ordinaryIdentity.sessionId !== existing.nativeId || ordinaryIdentity.threadId !== existing.nativeId)) {
        throw new BindingError('ordinary Claude bindings require matching owner and endpoint');
      }
      this.assertNativeOwnerFree(input.provider, input.nativeId, channelId);
      if (existing.conductorId !== input.conductorId || existing.repoKey !== input.repoKey) throw new BindingError('conductor identity changes require an explicit handoff');
      if (existing.conductorId && existing.provider !== input.provider) throw new BindingError('conductor provider changes require an explicit handoff');
      const generation = existing.generation + 1;
      return this.transaction(() => {
        if (this.db.prepare('SELECT 1 FROM thread_enrollments WHERE thread_id=? AND active=1').get(channelId)) {
          throw new BindingError('thread channel is already enrolled');
        }
        const current = this.getBinding(channelId);
        if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('rebind source identity is stale');
        if (this.hasUnresolved(channelId)) throw new UnresolvedWorkError('cannot rebind while work drains');
        if (this.hasUnresolvedBindingPost(channelId)) throw new UnresolvedWorkError('cannot rebind while a publication is unresolved');
        if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
          throw new BindingError('active thread enrollments require an observed intake cutoff');
        }
        this.assertLegacyMigrationSafe(channelId);
        this.assertNativeOwnerFree(input.provider, input.nativeId, channelId);
        if (typeof beforeMutation === 'function') beforeMutation();
        if (intakeCutoff !== null) {
          if (enrollmentProof) this.assertThreadEnrollmentCoverage(channelId, enrollmentProof);
          const updatedAt = now();
          this.setIntakeCutoffInTransaction(channelId, input.guildId, intakeCutoff, 'parent rebind intake fence', current);
          ordinaryBindingHandlers.advanceEnrolledThreadCutoffs(this, channelId, intakeCutoff, updatedAt);
        }
        this.db.prepare(`UPDATE bindings SET guild_id=?, provider=?, native_id=?, workspace=?, session_root=?, endpoint=?, category_id=?, readiness=?, generation=?, active=1, updated_at=? WHERE channel_id=?`)
          .run(input.guildId, input.provider, input.nativeId, input.workspace, input.sessionRoot, input.endpoint, input.categoryId, READINESS.PENDING, generation, now(), channelId);
        this.receipt(null, 'rebound', { channelId, conductorId: input.conductorId, generation, intakeCutoff: intakeCutoff || undefined });
        if (ordinary && !input.conductorId && !input.repoKey) {
          this.receipt(null, ORDINARY_RECEIPT_KINDS.BOUND, {
            channelId, guildId: input.guildId, provider: input.provider, nativeId: input.nativeId,
            workspace: input.workspace, generation,
            sessionRoot: input.sessionRoot,
            sessionId: ordinaryIdentity?.sessionId || input.nativeId,
            threadId: ordinaryIdentity?.threadId || input.nativeId,
            harness: ordinaryIdentity?.harness || undefined, endpoint: input.endpoint || undefined
          });
        }
        if (resetIntake) {
          this.db.prepare("UPDATE intake_watermarks SET state='pending', detail=?, gap_from=NULL, gap_to=NULL, updated_at=? WHERE channel_id=?")
            .run('binding generation changed; intake recovery reopened', now(), channelId);
        }
        return this.getBinding(channelId);
      });
    }

  function unbind(channelId, { expectedBinding = undefined, intakeCutoff = null } = {}) {
      assertText(channelId, 'channelId', 128);
      if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
      const binding = this.getBinding(channelId);
      if (!binding) throw new BindingError('channel is not bound');
      if (expectedBinding !== undefined && !bindingMatchesExpected(binding, expectedBinding)) {
        throw new StaleGenerationError('unbind source identity is stale');
      }
      if (this.hasUnresolved(channelId) || this.hasUnresolvedBindingPost(channelId)) {
        throw new UnresolvedWorkError('cannot unbind while work is unresolved');
      }
      return this.transaction(() => {
        const current = this.getBinding(channelId);
        const expected = expectedBinding === undefined ? binding : expectedBinding;
        if (!bindingMatchesExpected(current, expected)) throw new StaleGenerationError('unbind source identity is stale');
        if (this.hasUnresolved(channelId) || this.hasUnresolvedBindingPost(channelId)) {
          throw new UnresolvedWorkError('cannot unbind while work is unresolved');
        }
        if (!current.active) {
          threadEnrollmentHandlers.deactivateThreadEnrollments(this, channelId, current);
          return true;
        }
        this.assertLegacyMigrationSafe(channelId);
        if (intakeCutoff !== null) {
          this.setIntakeCutoffInTransaction(channelId, current.guildId, intakeCutoff, 'ordinary unbind intake fence', current);
          this.db.prepare("UPDATE intake_watermarks SET state='ready', updated_at=? WHERE channel_id=?")
            .run(now(), channelId);
        }
        threadEnrollmentHandlers.deactivateThreadEnrollments(this, channelId, current);
        this.db.prepare('UPDATE bindings SET active=0, updated_at=? WHERE channel_id=?').run(now(), channelId);
        this.receipt(null, 'unbound', {
          channelId, generation: current.generation,
          intakeCutoff: intakeCutoff || undefined
        });
        return true;
      });
    }

  function getBinding(channelId) {
      return rowBinding(this.db.prepare('SELECT * FROM bindings WHERE channel_id=?').get(channelId));
    }

  function listBindings() {
      return this.db.prepare('SELECT * FROM bindings ORDER BY channel_id').all().map(rowBinding);
    }

  function findNativeBinding(nativeId, provider = null) {
    assertUuid(nativeId);
    if (provider) assertProvider(provider);
    const row = provider
      ? this.db.prepare('SELECT * FROM bindings WHERE native_id=? AND provider=? ORDER BY active DESC, generation DESC LIMIT 1').get(nativeId, provider)
      : this.db.prepare('SELECT * FROM bindings WHERE native_id=? ORDER BY active DESC, generation DESC LIMIT 1').get(nativeId);
    return rowBinding(row);
  }

  function findConductorBinding(conductorId, provider) {
    assertConductorId(conductorId);
    assertProvider(provider);
    return rowBinding(this.db.prepare('SELECT * FROM bindings WHERE conductor_id=? AND provider=? ORDER BY active DESC, generation DESC LIMIT 1').get(conductorId, provider));
  }

  function setBindingReadiness(channelId, readiness, detail = null, expectedBinding = null) {
    assertText(channelId, 'channelId', 128);
    if (!Object.values(READINESS).includes(readiness)) throw new BindingError('invalid binding readiness');
    return this.transaction(() => {
      const binding = this.getBinding(channelId);
      if (!binding) throw new BindingError('channel is not bound');
      if (!bindingMatchesExpected(binding, expectedBinding)) return null;
      if (readiness === READINESS.READY && this._isOrdinaryBinding(binding) && !this._hasOrdinaryPreflight(binding)) {
        throw new BindingError(`ordinary ${binding.provider} native preflight is required before READY`);
      }
      if (readiness === READINESS.READY) this.assertLegacyMigrationSafe(channelId);
      this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=?').run(readiness, now(), channelId);
      this.receipt(null, 'binding-readiness', { channelId, conductorId: binding.conductorId,
        guildId: binding.guildId, provider: binding.provider, nativeId: binding.nativeId,
        generation: binding.generation, readiness, detail: detail || undefined });
      return this.getBinding(channelId);
    });
  }

  function findConductorHandoff(handoffId) {
    assertText(handoffId, 'handoffId', 256);
    const rows = this.db.prepare("SELECT detail FROM receipts WHERE kind='conductor-handoff' ORDER BY id DESC").all();
    for (const row of rows) {
      const detail = parseJson(row.detail, {});
      if (detail.handoffId === handoffId) return detail;
    }
    return null;
  }

  function hasUnboundReceipt(channelId, generation) {
    const rows = this.db.prepare("SELECT detail FROM receipts WHERE kind='unbound' ORDER BY id DESC").all();
    return rows.some(row => {
      const detail = parseJson(row.detail, {});
      return detail.channelId === channelId && detail.generation === generation;
    });
  }

  function handoffConductor({ channelId, provider, conductorId, repoKey, fromNativeId, fromGeneration, nativeId, workspace, endpoint, handoffId, intakeCutoff = null, enrollmentProof = null, carryAcceptedHuman = false }) {
    assertUuid(fromNativeId, 'fromNativeId');
    if (!Number.isInteger(fromGeneration) || fromGeneration < 1) throw new BindingError('fromGeneration must be a positive integer');
    assertText(handoffId, 'handoffId', 256);
    if (intakeCutoff !== null) assertText(intakeCutoff, 'lastSeenId', 128);
    const existing = this.getBinding(channelId);
    if (!existing || !existing.active) throw new BindingError('channel is not actively bound');
    const input = this.bindingInput({ channelId, provider, conductorId, repoKey, nativeId, workspace, endpoint }, existing);
    const previous = this.findConductorHandoff(handoffId);
    if (previous) {
      const sameRequest = previous.channelId === channelId && previous.provider === provider && previous.conductorId === conductorId &&
        previous.repoKey === repoKey && previous.fromNativeId === fromNativeId && previous.fromGeneration === fromGeneration &&
        previous.nativeId === nativeId && previous.generation === existing.generation && existing.nativeId === nativeId &&
        existing.generation === fromGeneration + 1 && existing.workspace === input.workspace && existing.endpoint === input.endpoint;
      if (!sameRequest) throw new BindingError('handoff ID is already used for a different successor');
      return this.transaction(() => {
        this.assertTopicPublicationSettled(channelId);
        this.receipt(null, 'conductor-handoff-retry', { channelId, conductorId, provider, handoffId, nativeId, generation: existing.generation });
        return { ...existing, handoffReconciled: true };
      });
    }
    if (existing.provider !== provider || existing.conductorId !== conductorId || existing.repoKey !== repoKey || existing.nativeId !== fromNativeId || existing.generation !== fromGeneration) {
      throw new StaleGenerationError('handoff source identity is stale');
    }
    if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
      throw new BindingError('active thread enrollments require an observed intake cutoff');
    }
    if (nativeId === fromNativeId) throw new BindingError('successor handoff requires a different native session UUID');
    const custodyRequest = {
      channelId, provider, conductorId, repoKey, handoffId,
      fromNativeId, fromGeneration,
      nativeId: input.nativeId, workspace: input.workspace, endpoint: input.endpoint,
      expectedGeneration: existing.generation + 1
    };
    // Carry mode computes eligibility and the deterministic evidence snapshot
    // before opening the transaction. The companion refuses the whole operation
    // when any active row on the channel does not qualify.
    const custodySnapshot = carryAcceptedHuman === true
      ? conductorCustodyHandlers.snapshotEligibleCustody(this, custodyRequest)
      : null;
    if (carryAcceptedHuman !== true && (this.hasUnresolved(channelId) || this.hasUnresolvedBindingPost(channelId))) {
      throw new UnresolvedWorkError('cannot handoff while work is unresolved');
    }
    this.assertNativeOwnerFree(provider, nativeId, channelId);
    return this.transaction(() => {
      const current = this.getBinding(channelId);
      if (!bindingMatchesExpected(current, existing)) throw new StaleGenerationError('handoff source identity is stale');
      if (carryAcceptedHuman !== true && (this.hasUnresolved(channelId) || this.hasUnresolvedBindingPost(channelId))) {
        throw new UnresolvedWorkError('cannot handoff while work is unresolved');
      }
      if (this._hasActiveThreadEnrollments(channelId) && intakeCutoff === null) {
        throw new BindingError('active thread enrollments require an observed intake cutoff');
      }
      this.assertLegacyMigrationSafe(channelId);
      if (enrollmentProof) this.assertThreadEnrollmentCoverage(channelId, enrollmentProof);
      const generation = existing.generation + 1;
      const updatedAt = now();
      if (intakeCutoff !== null) {
        this.setIntakeCutoffInTransaction(channelId, current.guildId, intakeCutoff, 'conductor handoff intake fence', current);
        ordinaryBindingHandlers.advanceEnrolledThreadCutoffs(this, channelId, intakeCutoff, updatedAt);
      }
      this.db.prepare(`UPDATE bindings SET native_id=?, workspace=?, session_root=?, endpoint=?, readiness=?, generation=?, updated_at=? WHERE channel_id=? AND provider=? AND conductor_id=? AND generation=? AND native_id=?`)
        .run(input.nativeId, input.workspace, input.sessionRoot, input.endpoint, READINESS.PENDING, generation, updatedAt, channelId, provider, conductorId, fromGeneration, fromNativeId);
      if (custodySnapshot) {
        conductorCustodyHandlers.verifySnapshotAndTransfer(this, custodySnapshot, custodyRequest, updatedAt);
      }
      this.receipt(null, 'conductor-handoff', {
        channelId, conductorId, repoKey, provider, handoffId,
        fromNativeId, fromGeneration, nativeId: input.nativeId, generation, intakeCutoff: intakeCutoff || undefined
      });
      return this.getBinding(channelId);
    });
  }

  function assertNativeOwnerFree(provider, nativeId, channelId = null) {
    const row = this.db.prepare('SELECT channel_id, provider FROM bindings WHERE provider=? AND native_id=? AND active=1').get(provider, nativeId);
    if (row && row.channel_id !== channelId) throw new BindingError('native session is already owned by another channel for this provider');
  }

  function assertConductorOwnerFree(provider, conductorId, channelId = null) {
    if (!conductorId) return;
    const row = this.db.prepare('SELECT channel_id FROM bindings WHERE provider=? AND conductor_id=? AND active=1').get(provider, conductorId);
    if (row && row.channel_id !== channelId) throw new BindingError('conductor identity is already bound to another channel for this provider');
  }

  return { bindingInput, bind, rebind, unbind, getBinding, listBindings, findNativeBinding, findConductorBinding, setBindingReadiness, findConductorHandoff, hasUnboundReceipt, handoffConductor, assertNativeOwnerFree, assertConductorOwnerFree };
}

module.exports = { createBindingLifecycleHandlers };
