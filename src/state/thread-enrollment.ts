import type { AgentProvider } from '../agent-message';
import type { Readiness } from '../topic';

export const THREAD_STATES = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  GAP: 'gap',
  UNAVAILABLE: 'unavailable'
} as const);

export type ThreadState = typeof THREAD_STATES[keyof typeof THREAD_STATES];

export const THREAD_RECEIPT_KINDS = Object.freeze({
  ENROLLED: 'thread-enrolled',
  BASELINE: 'thread-baseline',
  BOUNDARY: 'thread-boundary',
  CHECKPOINT: 'thread-checkpoint',
  RECONCILED: 'thread-reconcile-requested'
} as const);

export type ThreadReceiptKind = typeof THREAD_RECEIPT_KINDS[keyof typeof THREAD_RECEIPT_KINDS];

export const THREAD_INTAKE_REASONS = Object.freeze({
  GAP: 'thread-gap',
  UNAVAILABLE: 'thread-unavailable'
} as const);

export type ThreadIntakeReason = typeof THREAD_INTAKE_REASONS[keyof typeof THREAD_INTAKE_REASONS];

export interface ThreadBinding {
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  workspace: string;
  sessionRoot?: string | null;
  endpoint?: string | null;
  categoryId?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  readiness: Readiness;
  generation: number;
  active: boolean;
  updatedAt?: string;
}

export interface ThreadEnrollment {
  threadId: string;
  parentChannelId: string;
  guildId: string;
  state: ThreadState;
  active: boolean;
  adoptedThroughId: string | null;
  adoptedAt: string | null;
  lastSeenId: string | null;
  recoveredThroughId: string | null;
  lastAcceptedId: string | null;
  gapFrom: string | null;
  gapTo: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadRoute {
  binding: ThreadBinding;
  enrollment: ThreadEnrollment | null;
  deliveryChannelId: string;
  ready: boolean;
}

export interface ThreadEnrollmentInput {
  threadId: string;
  parentChannelId: string;
  guildId: string;
}

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

export interface ThreadEnrollmentDatabase {
  prepare(sql: string): SqlStatement;
}

export interface ThreadEnrollmentState {
  db: ThreadEnrollmentDatabase;
  transaction<T>(operation: () => T): T;
  getBinding(channelId: string): ThreadBinding | null;
  receipt(discordId: string | null, kind: ThreadReceiptKind, detail: Record<string, unknown>): void;
}

interface ErrorConstructor {
  new (message: string): Error;
}

export interface ThreadEnrollmentDependencies {
  BindingError: ErrorConstructor;
  THREAD_STATES: typeof THREAD_STATES;
  READINESS: { READY: Readiness };
  assertText(value: unknown, name: string, max?: number): string;
  bindingMatchesExpected(binding: ThreadBinding | null, expected: ThreadBinding | null): boolean;
  compareDiscordIds(left: string | null, right: string | null): number;
  now(): string;
}

function rowEnrollment(row: SqlRow | undefined): ThreadEnrollment | null {
  if (!row) return null;
  return {
    threadId: String(row.thread_id),
    parentChannelId: String(row.parent_channel_id),
    guildId: String(row.guild_id),
    state: row.state as ThreadState,
    active: Number(row.active) !== 0,
    adoptedThroughId: row.adopted_through_id == null ? null : String(row.adopted_through_id),
    adoptedAt: row.adopted_at == null ? null : String(row.adopted_at),
    lastSeenId: row.last_seen_id == null ? null : String(row.last_seen_id),
    recoveredThroughId: row.recovered_through_id == null ? null : String(row.recovered_through_id),
    lastAcceptedId: row.last_accepted_id == null ? null : String(row.last_accepted_id),
    gapFrom: row.gap_from == null ? null : String(row.gap_from),
    gapTo: row.gap_to == null ? null : String(row.gap_to),
    detail: row.detail == null ? null : String(row.detail),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function maxId(compareDiscordIds: ThreadEnrollmentDependencies['compareDiscordIds'], current: string | null, candidate: string | null): string | null {
  if (!candidate) return current;
  if (!current || compareDiscordIds(current, candidate) < 0) return candidate;
  return current;
}

export interface ThreadEnrollmentHandlers {
  getMessageRoute(state: ThreadEnrollmentState, deliveryChannelId: string): ThreadRoute | null;
  enrollThread(state: ThreadEnrollmentState, input: ThreadEnrollmentInput, expectedBinding?: ThreadBinding | null): ThreadEnrollment | null;
  getThreadEnrollment(state: ThreadEnrollmentState, threadId: string): ThreadEnrollment | null;
  listThreadEnrollments(state: ThreadEnrollmentState, parentChannelId?: string | null): ThreadEnrollment[];
  deactivateThreadEnrollments(state: ThreadEnrollmentState, parentChannelId: string, expectedBinding?: ThreadBinding | null): number;
  setThreadBaseline(state: ThreadEnrollmentState, threadId: string, latestId: string | null, expectedBinding?: ThreadBinding | null): ThreadEnrollment | null;
  markThreadBoundary(
    state: ThreadEnrollmentState,
    threadId: string,
    nextState: ThreadState,
    detail?: string | null,
    gapFrom?: string | null,
    gapTo?: string | null,
    expectedBinding?: ThreadBinding | null,
    coverageId?: string | null,
    lastSeenBaselineId?: string | null
  ): ThreadEnrollment | null;
  checkpointThread(state: ThreadEnrollmentState, threadId: string, coverageId: string, expectedBinding?: ThreadBinding | null): ThreadEnrollment | null;
  reconcileThread(state: ThreadEnrollmentState, threadId: string, expectedBinding?: ThreadBinding | null): ThreadEnrollment | null;
  noteThreadMessage(state: ThreadEnrollmentState, threadId: string, messageId: string, accepted?: boolean, coverageId?: string | null): ThreadEnrollment | null;
}

export function createThreadEnrollmentHandlers({
  BindingError,
  THREAD_STATES: states,
  READINESS,
  assertText,
  bindingMatchesExpected,
  compareDiscordIds,
  now
}: ThreadEnrollmentDependencies): ThreadEnrollmentHandlers {
  const validStates = new Set<ThreadState>(Object.values(states));

  function requireEnrollment(state: ThreadEnrollmentState, threadId: string): ThreadEnrollment {
    const enrollment = rowEnrollment(state.db.prepare('SELECT * FROM thread_enrollments WHERE thread_id=?').get(threadId));
    if (!enrollment) throw new BindingError('thread enrollment is unknown');
    return enrollment;
  }

  function currentParent(state: ThreadEnrollmentState, enrollment: ThreadEnrollment, expectedBinding: ThreadBinding | null | undefined): ThreadBinding | null {
    const binding = state.getBinding(enrollment.parentChannelId);
    if (!binding || binding.guildId !== enrollment.guildId || !bindingMatchesExpected(binding, expectedBinding || null)) return null;
    return binding;
  }

  function routeReady(binding: ThreadBinding, enrollment: ThreadEnrollment | null): boolean {
    return Boolean(binding.active && binding.readiness === READINESS.READY &&
      (!enrollment || (enrollment.active && enrollment.state === states.READY)));
  }

  const handlers: ThreadEnrollmentHandlers = {
    getMessageRoute(state, deliveryChannelId) {
      assertText(deliveryChannelId, 'deliveryChannelId', 128);
      const direct = state.getBinding(deliveryChannelId);
      const enrollmentRow = state.db.prepare('SELECT * FROM thread_enrollments WHERE thread_id=?').get(deliveryChannelId);
      const enrollment = rowEnrollment(enrollmentRow);
      if (enrollmentRow) {
        if (!enrollment?.active) return null;
        const binding = enrollment ? state.getBinding(enrollment.parentChannelId) : null;
        if (!binding || binding.guildId !== enrollment?.guildId) return null;
        return {
          binding,
          enrollment,
          deliveryChannelId,
          ready: routeReady(binding, enrollment)
        };
      }
      if (!direct) return null;
      return {
        binding: direct,
        enrollment: null,
        deliveryChannelId,
        ready: routeReady(direct, null)
      };
    },

    enrollThread(state, input, expectedBinding = null) {
      const threadId = assertText(input?.threadId, 'threadId', 128);
      const parentChannelId = assertText(input?.parentChannelId, 'parentChannelId', 128);
      const guildId = assertText(input?.guildId, 'guildId', 128);
      if (threadId === parentChannelId) throw new BindingError('thread must differ from its bound parent');
      return state.transaction(() => {
        const binding = state.getBinding(parentChannelId);
        if (!binding || !binding.active || binding.guildId !== guildId || !bindingMatchesExpected(binding, expectedBinding)) return null;
        if (state.getBinding(threadId)?.active) throw new BindingError('thread channel is already bound');
        const existing = rowEnrollment(state.db.prepare('SELECT * FROM thread_enrollments WHERE thread_id=?').get(threadId));
        if (existing) {
          if (existing.parentChannelId !== parentChannelId || existing.guildId !== guildId) {
            throw new BindingError('thread is already enrolled under another parent');
          }
          if (existing.active) return existing;
        }
        const timestamp = now();
        state.db.prepare(`INSERT INTO thread_enrollments(
          thread_id, parent_channel_id, guild_id, state, active,
          adopted_through_id, adopted_at, last_seen_id, recovered_through_id, last_accepted_id,
          gap_from, gap_to, detail, created_at, updated_at
        ) VALUES(?, ?, ?, ?, 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          state=excluded.state, active=1, adopted_through_id=NULL, adopted_at=NULL,
          last_seen_id=NULL, recovered_through_id=NULL, last_accepted_id=NULL,
          gap_from=NULL, gap_to=NULL, detail=NULL, updated_at=excluded.updated_at`).run(
          threadId, parentChannelId, guildId, states.PENDING, timestamp, timestamp
        );
        state.receipt(null, THREAD_RECEIPT_KINDS.ENROLLED, { threadId, parentChannelId, guildId, state: states.PENDING });
        return handlers.getThreadEnrollment(state, threadId);
      });
    },

    getThreadEnrollment(state, threadId) {
      assertText(threadId, 'threadId', 128);
      return rowEnrollment(state.db.prepare('SELECT * FROM thread_enrollments WHERE thread_id=?').get(threadId));
    },

    listThreadEnrollments(state, parentChannelId = null) {
      if (parentChannelId !== null && parentChannelId !== undefined) assertText(parentChannelId, 'parentChannelId', 128);
      const rows = parentChannelId == null
        ? state.db.prepare('SELECT * FROM thread_enrollments ORDER BY parent_channel_id, thread_id').all()
        : state.db.prepare('SELECT * FROM thread_enrollments WHERE parent_channel_id=? ORDER BY thread_id').all(parentChannelId);
      return rows.map(row => rowEnrollment(row)).filter((row): row is ThreadEnrollment => row !== null);
    },

    deactivateThreadEnrollments(state, parentChannelId, expectedBinding = null) {
      const checkedParentChannelId = assertText(parentChannelId, 'parentChannelId', 128);
      const binding = state.getBinding(checkedParentChannelId);
      if (!binding || !bindingMatchesExpected(binding, expectedBinding || null)) return 0;
      const rows = state.db.prepare('SELECT thread_id FROM thread_enrollments WHERE parent_channel_id=? AND active=1 ORDER BY thread_id')
        .all(checkedParentChannelId);
      if (!rows.length) return 0;
      const timestamp = now();
      const detail = 'parent binding was unbound';
      state.db.prepare(`UPDATE thread_enrollments
        SET state=?, active=0, detail=?, updated_at=?
        WHERE parent_channel_id=? AND active=1`).run(
        states.UNAVAILABLE, detail, timestamp, checkedParentChannelId
      );
      for (const row of rows) {
        state.receipt(null, THREAD_RECEIPT_KINDS.BOUNDARY, {
          threadId: String(row.thread_id),
          parentChannelId: checkedParentChannelId,
          state: states.UNAVAILABLE,
          detail,
          generation: binding.generation
        });
      }
      return rows.length;
    },

    setThreadBaseline(state, threadId, latestId, expectedBinding = null) {
      assertText(threadId, 'threadId', 128);
      if (latestId !== null) assertText(latestId, 'latestId', 128);
      return state.transaction(() => {
        const existing = requireEnrollment(state, threadId);
        const binding = currentParent(state, existing, expectedBinding);
        if (!binding || !binding.active) return null;
        const timestamp = now();
        const adoptedAt = existing.adoptedAt || timestamp;
        const adoptedThroughId = existing.adoptedAt ? existing.adoptedThroughId : latestId;
        const lastSeenId = maxId(compareDiscordIds, existing.lastSeenId, latestId);
        const recoveredThroughId = maxId(compareDiscordIds, existing.recoveredThroughId, latestId);
        state.db.prepare(`UPDATE thread_enrollments SET adopted_through_id=?, adopted_at=?, last_seen_id=?, recovered_through_id=?, updated_at=?
          WHERE thread_id=? AND parent_channel_id=? AND active=1`).run(
          adoptedThroughId, adoptedAt, lastSeenId, recoveredThroughId, timestamp, threadId, existing.parentChannelId
        );
        state.receipt(null, THREAD_RECEIPT_KINDS.BASELINE, {
          threadId, parentChannelId: existing.parentChannelId, latestId: adoptedThroughId,
          adoptedAt, recoveredThroughId
        });
        return handlers.getThreadEnrollment(state, threadId);
      });
    },

    markThreadBoundary(state, threadId, nextState, detail = null, gapFrom = null, gapTo = null, expectedBinding = null, coverageId = undefined, lastSeenBaselineId = undefined) {
      assertText(threadId, 'threadId', 128);
      if (!validStates.has(nextState)) throw new BindingError('invalid thread enrollment state');
      if (gapFrom !== null) assertText(gapFrom, 'gapFrom', 128);
      if (gapTo !== null) assertText(gapTo, 'gapTo', 128);
      const boundedDetail = detail == null ? null : String(detail).slice(0, 1000) || null;
      return state.transaction(() => {
        const existing = requireEnrollment(state, threadId);
        const binding = currentParent(state, existing, expectedBinding);
        if (!binding || !binding.active) return null;
        if (nextState === states.READY && coverageId !== undefined && lastSeenBaselineId !== undefined && existing.lastSeenId &&
          (!coverageId || compareDiscordIds(existing.lastSeenId, coverageId) > 0) &&
          (!lastSeenBaselineId || compareDiscordIds(existing.lastSeenId, lastSeenBaselineId) > 0)) return existing;
        const timestamp = now();
        const persistedGapFrom = nextState === states.READY ? null : gapFrom;
        const persistedGapTo = nextState === states.READY ? null : gapTo;
        state.db.prepare('UPDATE thread_enrollments SET state=?, detail=?, gap_from=?, gap_to=?, updated_at=? WHERE thread_id=? AND active=1')
          .run(nextState, boundedDetail, persistedGapFrom, persistedGapTo, timestamp, threadId);
        state.receipt(null, THREAD_RECEIPT_KINDS.BOUNDARY, {
          threadId, parentChannelId: existing.parentChannelId, state: nextState,
          detail: boundedDetail, gapFrom: persistedGapFrom, gapTo: persistedGapTo
        });
        return handlers.getThreadEnrollment(state, threadId);
      });
    },

    checkpointThread(state, threadId, coverageId, expectedBinding = null) {
      assertText(threadId, 'threadId', 128);
      const checkedCoverageId = assertText(coverageId, 'coverageId', 128);
      return state.transaction(() => {
        const existing = requireEnrollment(state, threadId);
        const binding = currentParent(state, existing, expectedBinding);
        if (!binding || !binding.active) return null;
        if (existing.lastSeenId && compareDiscordIds(existing.lastSeenId, checkedCoverageId) < 0) return existing;
        const recoveredThroughId = maxId(compareDiscordIds, existing.recoveredThroughId, checkedCoverageId);
        const timestamp = now();
        state.db.prepare('UPDATE thread_enrollments SET recovered_through_id=?, updated_at=? WHERE thread_id=? AND active=1')
          .run(recoveredThroughId, timestamp, threadId);
        state.receipt(null, THREAD_RECEIPT_KINDS.CHECKPOINT, { threadId, coverageId: recoveredThroughId });
        return handlers.getThreadEnrollment(state, threadId);
      });
    },

    reconcileThread(state, threadId, expectedBinding = null) {
      assertText(threadId, 'threadId', 128);
      return state.transaction(() => {
        const existing = requireEnrollment(state, threadId);
        if (!existing.active) return null;
        const binding = currentParent(state, existing, expectedBinding);
        if (!binding || !binding.active) return null;
        if (existing.state !== states.GAP && existing.state !== states.UNAVAILABLE) return existing;
        const timestamp = now();
        state.db.prepare('UPDATE thread_enrollments SET state=?, detail=NULL, gap_from=NULL, gap_to=NULL, updated_at=? WHERE thread_id=? AND parent_channel_id=? AND active=1')
          .run(states.PENDING, timestamp, threadId, existing.parentChannelId);
        state.receipt(null, THREAD_RECEIPT_KINDS.RECONCILED, {
          threadId,
          parentChannelId: existing.parentChannelId,
          previousState: existing.state,
          state: states.PENDING
        });
        return handlers.getThreadEnrollment(state, threadId);
      });
    },

    noteThreadMessage(state, threadId, messageId, accepted = false, coverageId = null) {
      assertText(threadId, 'threadId', 128);
      assertText(messageId, 'messageId', 128);
      if (coverageId !== null) assertText(coverageId, 'coverageId', 128);
      const existing = handlers.getThreadEnrollment(state, threadId);
      if (!existing || !existing.active) return null;
      const timestamp = now();
      const lastSeenId = maxId(compareDiscordIds, existing.lastSeenId, messageId);
      const lastAcceptedId = accepted ? maxId(compareDiscordIds, existing.lastAcceptedId, messageId) : existing.lastAcceptedId;
      const recoveredThroughId = maxId(compareDiscordIds, existing.recoveredThroughId, coverageId);
      state.db.prepare('UPDATE thread_enrollments SET last_seen_id=?, last_accepted_id=?, recovered_through_id=?, updated_at=? WHERE thread_id=? AND active=1')
        .run(lastSeenId, lastAcceptedId, recoveredThroughId, timestamp, threadId);
      return handlers.getThreadEnrollment(state, threadId);
    }
  };
  return handlers;
}
