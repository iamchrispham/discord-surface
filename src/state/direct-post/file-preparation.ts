import { queryFilePreparationRows, latestFilePreparation } from './receipt-queries';
import type { DirectPostReceiptDetail, DirectPostState, DirectPostFilePreparationSeed, DirectPostPartMeta, DirectPostHandlers, DirectPostErrorConstructor, DirectPostDependencies } from './contracts';
import { DIRECT_POST_FILE_LIMITS, DIRECT_POST_FILE_PHASES, stagedDirectPostFilePath } from '../../direct-post-file';
import type { DirectPostFileManifest, DirectPostFilePreparation } from '../../direct-post-file';
import { NATIVE_REPLY_FILE_JOURNAL, NATIVE_REPLY_FILE_PREPARATION } from '../native-reply-file';

function assertFileSeed(seed: DirectPostFilePreparationSeed, BindingError: DirectPostErrorConstructor, assertText: DirectPostDependencies['assertText']): void {
  assertText(seed.preparationId, 'preparationId', 128);
  assertText(seed.requestId, 'requestId', 256);
  assertText(seed.custodyRoot, 'custodyRoot', 4096);
  assertText(seed.sourcePath, 'sourcePath', 4096);
  assertText(seed.stagedPath, 'stagedPath', 4096);
  assertText(seed.filename, 'filename', 255);
  assertText(seed.caption, 'caption', 2000);
  assertText(seed.captionHash, 'captionHash', 128);
  if (!Number.isSafeInteger(seed.size) || seed.size < 0 || seed.size > DIRECT_POST_FILE_LIMITS.maxBytes) throw new BindingError('attachment size is outside the bounded limit');
  if (!Number.isSafeInteger(seed.generation) || seed.generation < 1) throw new BindingError('generation is invalid');
  if (!Number.isInteger(seed.ownerPid) || seed.ownerPid < 1) throw new BindingError('preparation owner identity is invalid');
  if (stagedDirectPostFilePath(seed.custodyRoot, seed.preparationId) !== seed.stagedPath) {
    throw new BindingError('direct post staged path does not match its custody root');
  }
}

function assertFileIdentity(existing: DirectPostReceiptDetail, incoming: Partial<DirectPostFilePreparationSeed> | DirectPostFileManifest, BindingError: DirectPostErrorConstructor): void {
  for (const key of ['requestId', 'custodyRoot', 'stagedPath', 'filename', 'size', 'caption', 'captionHash',
    'channelId', 'guildId', 'provider', 'nativeId', 'generation', 'operatorId', 'inReplyTo', 'conductorId', 'repoKey'] as const) {
    const incomingValue = (incoming as unknown as Record<string, unknown>)[key];
    if (existing[key] !== undefined && incomingValue !== undefined && existing[key] !== incomingValue) throw new BindingError(`direct post file preparation cannot override immutable ${key}`);
  }
}

export function assertFilePreparationClaim(state: DirectPostState, meta: DirectPostPartMeta, BindingError: DirectPostErrorConstructor,
  kind: string, parseJson: DirectPostDependencies['parseJson'], StateCorruptError: DirectPostErrorConstructor): void {
  if (!meta.fileManifest) return;
  const preparationId = meta.fileManifest.preparationId;
  const existing = latestFilePreparation(state, kind, parseJson, StateCorruptError, preparationId);
  if (!existing || existing.detail.phase !== DIRECT_POST_FILE_PHASES.ADMITTED) {
    throw new BindingError('direct post file preparation is no longer admitted');
  }
  assertFileIdentity(existing.detail, {
    requestId: meta.requestId,
    stagedPath: meta.fileManifest.stagedPath,
    filename: meta.fileManifest.filename,
    size: meta.fileManifest.size,
    caption: meta.fileManifest.caption,
    captionHash: meta.fileManifest.captionHash
  }, BindingError);
  for (const key of ['requestId', 'channelId', 'guildId', 'provider', 'nativeId', 'generation', 'operatorId', 'inReplyTo'] as const) {
    const expected = existing.detail[key];
    const actual = (meta as unknown as Record<string, unknown>)[key];
    if ((expected ?? null) !== (actual ?? null)) throw new BindingError(`direct post file preparation cannot override immutable ${key}`);
  }
  for (const key of ['conductorId', 'repoKey'] as const) {
    if ((existing.detail[key] ?? null) !== ((meta as unknown as Record<string, unknown>)[key] ?? null)) {
      throw new BindingError(`direct post file preparation cannot override immutable ${key}`);
    }
  }
}

export function createFilePreparationHandlers(dependencies: DirectPostDependencies): Pick<DirectPostHandlers, 'findDirectPostFilePreparation' | 'beginDirectPostFilePreparation' | 'admitDirectPostFilePreparation' | 'releaseDirectPostFilePreparation'> {
  const { BindingError, StateCorruptError, DIRECT_POST_ATTEMPT, DIRECT_POST_OUTCOME, DIRECT_POST_FILE_PREPARATION, assertText, parseJson, now } = dependencies;
  return {
    findDirectPostFilePreparation(state, requestId) {
      assertText(requestId, 'requestId', 256);
      const rows = queryFilePreparationRows(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError, null, requestId);
      const latest = rows.at(-1);
      return latest ? latest.detail as unknown as DirectPostFilePreparation : null;
    },

    beginDirectPostFilePreparation(state, seed) {
      assertFileSeed(seed, BindingError, assertText);
      return state.transaction(() => {
        const rows = queryFilePreparationRows(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError);
        const latestByPreparation = new Map<string, { kind: string; detail: any }>();
        for (const row of rows) {
          const id = row.detail.preparationId;
          if (typeof id === 'string') latestByPreparation.set(`${DIRECT_POST_FILE_PREPARATION}\u0000${id}`, {
            kind: DIRECT_POST_FILE_PREPARATION,
            detail: row.detail
          });
        }
        const nativeRows = state.db.prepare('SELECT detail FROM receipts WHERE kind=? ORDER BY id').all(NATIVE_REPLY_FILE_PREPARATION);
        for (const row of nativeRows) {
          const detail = parseJson(row.detail, null);
          if (!detail || detail.journal !== NATIVE_REPLY_FILE_JOURNAL || typeof detail.preparationId !== 'string' || typeof detail.phase !== 'string') {
            throw new StateCorruptError('file preparation receipt is malformed');
          }
          latestByPreparation.set(`${NATIVE_REPLY_FILE_PREPARATION}\u0000${detail.preparationId}`, {
            kind: NATIVE_REPLY_FILE_PREPARATION,
            detail
          });
        }
        const existing = rows.filter(row => row.detail.requestId === seed.requestId).at(-1);
        if (existing && existing.detail.phase === DIRECT_POST_FILE_PHASES.RELEASED) {
          throw new BindingError('direct post file request key was already released');
        }
        if (existing && existing.detail.phase !== DIRECT_POST_FILE_PHASES.RELEASED) {
          assertFileIdentity(existing.detail, seed, BindingError);
          return existing.detail as unknown as DirectPostFilePreparation;
        }
        const active = typeof state.activeFilePreparationCount === 'function'
          ? state.activeFilePreparationCount()
          : [...latestByPreparation.values()].filter(({ detail }) => detail.reservesCapacity !== false &&
            detail.phase !== DIRECT_POST_FILE_PHASES.RELEASED).length;
        if (active >= DIRECT_POST_FILE_LIMITS.maxReservations) {
          const held = [...latestByPreparation.values()]
            .filter(({ detail }) => detail.reservesCapacity !== false && detail.phase !== DIRECT_POST_FILE_PHASES.RELEASED)
            .map(({ kind, detail }) => kind === DIRECT_POST_FILE_PREPARATION
              ? { preparationId: detail.preparationId, requestId: detail.requestId, phase: detail.phase }
              : { preparationId: detail.preparationId, messageId: detail.messageId, phase: detail.phase });
          throw new BindingError(`direct post file capacity is exhausted: ${JSON.stringify(held)}`);
        }
        const next = {
          journal: 'direct-post-v1',
          ...seed,
          phase: DIRECT_POST_FILE_PHASES.PREPARING,
          sha256: ''
        };
        state.receipt(null, DIRECT_POST_FILE_PREPARATION, next);
        return next as unknown as DirectPostFilePreparation;
      });
    },

    admitDirectPostFilePreparation(state, preparationId, manifest) {
      assertText(preparationId, 'preparationId', 128);
      if (!manifest || manifest.preparationId !== preparationId || manifest.size < 0 || manifest.size > DIRECT_POST_FILE_LIMITS.maxBytes) {
        throw new BindingError('direct post file manifest is invalid');
      }
      return state.transaction(() => {
        const existing = latestFilePreparation(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError, preparationId);
        if (!existing) throw new BindingError('direct post file preparation is unknown');
        if (existing.detail.phase === DIRECT_POST_FILE_PHASES.ADMITTED) {
          assertFileIdentity(existing.detail, manifest, BindingError);
          if (existing.detail.sha256 !== manifest.sha256) throw new BindingError('direct post file preparation hash cannot change');
          return existing.detail as unknown as DirectPostFilePreparation;
        }
        if (existing.detail.phase !== DIRECT_POST_FILE_PHASES.PREPARING) throw new BindingError('direct post file preparation is not open');
        assertFileIdentity(existing.detail, manifest, BindingError);
        const next = { ...existing.detail, ...manifest, phase: DIRECT_POST_FILE_PHASES.ADMITTED };
        state.receipt(null, DIRECT_POST_FILE_PREPARATION, next);
        return next as unknown as DirectPostFilePreparation;
      });
    },

    releaseDirectPostFilePreparation(state, preparationId, removeFile) {
      assertText(preparationId, 'preparationId', 128);
      return state.transaction(() => {
        const existing = latestFilePreparation(state, DIRECT_POST_FILE_PREPARATION, parseJson, StateCorruptError, preparationId);
        if (!existing) throw new BindingError('direct post file preparation is unknown');
        if (existing.detail.phase === DIRECT_POST_FILE_PHASES.RELEASED) return existing.detail as unknown as DirectPostFilePreparation;
        if (existing.detail.phase !== DIRECT_POST_FILE_PHASES.PREPARING && existing.detail.phase !== DIRECT_POST_FILE_PHASES.ADMITTED) {
          throw new BindingError('direct post file preparation cannot be cleaned up');
        }
        if (existing.detail.phase === DIRECT_POST_FILE_PHASES.PREPARING) {
          const ownerPid = Number(existing.detail.ownerPid);
          if (!Number.isInteger(ownerPid) || ownerPid < 1) throw new BindingError('preparing file cleanup requires an owner identity');
          const ownerIdentity = {
            ownerPid,
            ownerStartTime: typeof existing.detail.ownerStartTime === 'string' ? existing.detail.ownerStartTime : null,
            ownerCommand: typeof existing.detail.ownerCommand === 'string' ? existing.detail.ownerCommand : null
          };
          if (state.directPostOwnerAlive(ownerPid, ownerIdentity)) {
            throw new BindingError('direct post file preparation owner is still active');
          }
        }
        const requestId = typeof existing.detail.requestId === 'string' ? existing.detail.requestId : null;
        if (!requestId) throw new StateCorruptError('direct post file preparation request id is malformed');
        const attempts = state.directPostRows(requestId)
          .filter(row => row.kind === DIRECT_POST_ATTEMPT);
        const outcomes = new Map(state.directPostRows(requestId)
          .filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail.attemptId)
          .map(row => [row.detail.attemptId, row.detail.outcome]));
        if (attempts.some(row => !outcomes.has(row.detail.attemptId) || outcomes.get(row.detail.attemptId) === 'unknown')) {
          throw new BindingError('direct post file cleanup requires a resolved network outcome');
        }
        removeFile(existing.detail as unknown as DirectPostFilePreparation);
        const next = { ...existing.detail, phase: DIRECT_POST_FILE_PHASES.RELEASED, releasedAt: now() };
        state.receipt(null, DIRECT_POST_FILE_PREPARATION, next);
        return next as unknown as DirectPostFilePreparation;
      });
    }
  };
}
