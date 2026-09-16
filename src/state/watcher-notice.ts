import {
  WATCHER_NOTICE_KIND,
  WATCHER_NOTICE_PROVIDERS,
  sameWatcherAddress,
  sameWatcherNotice,
  validWatcherAddress,
  validateWatcherNotice,
  type WatcherAddress,
  type WatcherNotice
} from '../watcher-notice';
import type { NativeReplyFilePhase } from './native-reply-file';

export const WATCHER_NOTICE_RECEIPTS = Object.freeze({
  ARM: 'watcher-notice-arm',
  TRIGGER: 'watcher-notice-trigger',
  PROVENANCE: 'watcher-notice',
  PUBLICATION: 'watcher-notice-publication',
  CONSUMED: 'watcher-notice-consumed'
} as const);

export const WATCHER_NOTICE_AUTHORITY = Object.freeze({
  CLAUDE: WATCHER_NOTICE_PROVIDERS.CLAUDE,
  NOTICE_ONLY: 'notice-only'
} as const);

export const WATCHER_NOTICE_JOURNAL = 'watcher-notice-v1' as const;
export const WATCHER_NOTICE_PUBLICATION_SOURCE = 'accepted-child-publication' as const;
export const WATCHER_NOTICE_EVIDENCE_KIND = 'watcher-notice' as const;

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): { changes?: number };
}

interface WatcherDatabase {
  prepare(sql: string): SqlStatement;
}

interface WatcherBinding extends WatcherAddress {
  active: boolean;
  workspace: string;
  endpoint?: string | null;
  sessionRoot?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  readiness?: string;
}

interface WatcherEnrollment {
  threadId: string;
  parentChannelId: string;
  guildId: string;
  active: boolean;
  state: string;
}

interface WatcherRoute {
  binding: WatcherBinding;
  enrollment: WatcherEnrollment | null;
  deliveryChannelId: string;
  ready: boolean;
}

export interface WatcherNoticeArm {
  armKey: string;
  authority: typeof WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY;
  provider: typeof WATCHER_NOTICE_PROVIDERS.CLAUDE;
  operatorId: string;
  source: WatcherAddress;
  target: WatcherAddress;
  workspace: string;
  endpoint: string | null;
  sessionRoot: string | null;
  conductorId: string | null;
  repoKey: string | null;
  generation: number;
  createdAt: string;
  receiptId?: number;
}

export interface WatcherNoticeCaller {
  harness?: unknown;
  sessionId?: unknown;
  threadId?: unknown;
}

export interface WatcherNoticeArmInput {
  armKey: string;
  parentChannelId: string;
  childChannelId: string;
  provider: string;
  nativeId: string;
  generation: number;
  caller: WatcherNoticeCaller;
}

interface WatcherNoticeProvenance {
  packet: WatcherNotice;
  authorId: string;
  receiptId?: number;
  recordedAt?: string;
}

interface FoundWatcherNotice {
  messageId: string;
  provenance: WatcherNoticeProvenance;
}

interface WatcherMessage {
  id: string;
  guildId: string;
  channelId: string;
  deliveryChannelId?: string | null;
  authorId: string;
  provider: string;
  nativeId: string;
  generation: number;
  state: string;
  replyText?: string | null;
  replyNonce?: string | null;
  replyMessageId?: string | null;
  replyNextPart: number;
  watcherNotice?: WatcherNotice | null;
  decisionResult?: unknown;
}

interface WatcherBindingCheck {
  binding: WatcherBinding | null;
  identity: boolean;
  current: boolean;
  deliveryChannelId: string;
  enrollment?: WatcherEnrollment | null;
}

interface WatcherState {
  db: WatcherDatabase;
  transaction<T>(operation: () => T): T;
  requireConfig(): { operatorId: string; guildId: string };
  getBinding(channelId: string): WatcherBinding | null;
  getMessageRoute(deliveryChannelId: string): WatcherRoute | null;
  getWatcherNotice(messageId: string): WatcherNoticeProvenance | null;
  getMessage(messageId: string): WatcherMessage | null;
  nativeReplyFilePreparation(messageId: string): { phase: NativeReplyFilePhase } | null;
  currentMessageBinding(message: WatcherMessage): WatcherBindingCheck;
  hasNativeAcknowledgment(message: WatcherMessage): boolean;
  listReplyParts(messageId: string): unknown[];
  isInteractionMessage(messageId: string): boolean;
  receipt(discordId: string | null, kind: string, detail: Record<string, unknown>): void;
}

interface ErrorConstructor {
  new (message: string): Error;
}

export interface WatcherNoticeDependencies {
  BindingError: ErrorConstructor;
  AuthorizationError: ErrorConstructor;
  StaleGenerationError: ErrorConstructor;
  StateCorruptError: ErrorConstructor;
  MESSAGE_STATES: Readonly<{
    SUBMITTED: string;
    AGENT_HANDLED_WITHOUT_POST: string;
  }>;
  NATIVE_REPLY_FILE_PHASES: typeof import('./native-reply-file').NATIVE_REPLY_FILE_PHASES;
  assertText(value: unknown, name: string, max?: number): string;
  assertUuid(value: unknown, name?: string): string;
  now(): string;
}

export interface WatcherNoticePublicationEvent {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  isBot: boolean;
}

export interface WatcherNoticeConsumeInput {
  messageId: string;
  provider: string;
  nativeId: string;
  generation: number;
  channelId?: string | null;
}

function parseDetail(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameBinding(binding: WatcherBinding | null, arm: WatcherNoticeArm): boolean {
  return Boolean(binding?.active) && binding?.channelId === arm.source.channelId && binding.guildId === arm.source.guildId &&
    binding.provider === arm.provider && binding.nativeId === arm.source.nativeId && binding.generation === arm.generation &&
    binding.workspace === arm.workspace && (binding.endpoint || null) === arm.endpoint && (binding.sessionRoot || null) === arm.sessionRoot &&
    (binding.conductorId || null) === arm.conductorId && (binding.repoKey || null) === arm.repoKey;
}

function addressFromBinding(binding: WatcherBinding): WatcherAddress {
  return {
    guildId: binding.guildId,
    channelId: binding.channelId,
    provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
    nativeId: binding.nativeId,
    generation: binding.generation
  };
}

function readArmRow(row: SqlRow | undefined, deps: WatcherNoticeDependencies): WatcherNoticeArm | null {
  if (!row) return null;
  const detail = parseDetail(row.detail);
  if (!detail || detail.journal !== WATCHER_NOTICE_JOURNAL || detail.authority !== WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY ||
      detail.provider !== WATCHER_NOTICE_PROVIDERS.CLAUDE || typeof detail.armKey !== 'string' ||
      !detail.source || !detail.target || typeof detail.operatorId !== 'string' || typeof detail.workspace !== 'string' ||
      typeof detail.generation !== 'number' || !Number.isSafeInteger(detail.generation)) {
    throw new deps.StateCorruptError('watcher notice arm receipt is malformed');
  }
  const source = detail.source as WatcherAddress;
  const target = detail.target as WatcherAddress;
  if (!validWatcherAddress(source) || !validWatcherAddress(target) || source.channelId === target.channelId) {
    throw new deps.StateCorruptError('watcher notice arm addresses are malformed');
  }
  return {
    armKey: detail.armKey,
    authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY,
    provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
    operatorId: detail.operatorId,
    source,
    target,
    workspace: detail.workspace,
    endpoint: typeof detail.endpoint === 'string' ? detail.endpoint : null,
    sessionRoot: typeof detail.sessionRoot === 'string' ? detail.sessionRoot : null,
    conductorId: typeof detail.conductorId === 'string' ? detail.conductorId : null,
    repoKey: typeof detail.repoKey === 'string' ? detail.repoKey : null,
    generation: detail.generation,
    createdAt: typeof row.created_at === 'string' ? row.created_at : deps.now(),
    ...(Number.isSafeInteger(row.id) ? { receiptId: Number(row.id) } : {})
  };
}

function armRows(state: WatcherState, armKey: string): Array<{ id: number; detail: unknown; created_at: string }> {
  return state.db.prepare(`SELECT id, detail, created_at FROM receipts
    WHERE discord_id IS NULL AND kind=? AND json_extract(detail, '$.armKey')=? ORDER BY id`).all(
    WATCHER_NOTICE_RECEIPTS.ARM, armKey
  ) as Array<{ id: number; detail: unknown; created_at: string }>;
}

function sameArm(left: WatcherNoticeArm, right: WatcherNoticeArm): boolean {
  return left.armKey === right.armKey && left.authority === right.authority && left.provider === right.provider &&
    left.operatorId === right.operatorId && sameWatcherAddress(left.source, right.source) &&
    sameWatcherAddress(left.target, right.target) && left.workspace === right.workspace && left.endpoint === right.endpoint &&
    left.conductorId === right.conductorId && left.repoKey === right.repoKey && left.sessionRoot === right.sessionRoot && left.generation === right.generation;
}

function getArm(state: WatcherState, armKey: string, deps: WatcherNoticeDependencies): WatcherNoticeArm | null {
  deps.assertText(armKey, 'armKey', 256);
  const rows = armRows(state, armKey);
  const arms = rows.map(row => readArmRow({ ...row, id: row.id, detail: row.detail, created_at: row.created_at }, deps));
  return arms.at(-1) || null;
}

function currentArmRoute(state: WatcherState, arm: WatcherNoticeArm, requireReady: boolean, deps: WatcherNoticeDependencies): { binding: WatcherBinding; route: WatcherRoute } {
  const config = state.requireConfig();
  if (config.guildId !== arm.source.guildId || config.operatorId !== arm.operatorId) {
    throw new deps.StaleGenerationError('watcher notice arm installation scope is stale');
  }
  const binding = state.getBinding(arm.source.channelId);
  if (!sameBinding(binding, arm)) throw new deps.StaleGenerationError('watcher notice arm binding is stale');
  const route = state.getMessageRoute(arm.target.channelId);
  if (!route?.enrollment?.active || route.enrollment.threadId !== arm.target.channelId ||
      route.enrollment.parentChannelId !== arm.source.channelId || route.enrollment.guildId !== arm.source.guildId ||
      !sameBinding(route.binding, arm) || (requireReady && !route.ready)) {
    throw new deps.StaleGenerationError(`watcher notice child route is ${requireReady ? 'not ready' : 'stale'}`);
  }
  return { binding: binding as WatcherBinding, route };
}

function sameNotice(left: WatcherNotice, right: WatcherNotice): boolean {
  return left.id === right.id && left.kind === right.kind && left.armKey === right.armKey && left.triggerKey === right.triggerKey &&
    sameWatcherAddress(left.source, right.source) && sameWatcherAddress(left.target, right.target) && left.text === right.text;
}

function triggerRows(state: WatcherState, packet: WatcherNotice): Array<{ id: number; detail: unknown }> {
  return state.db.prepare(`SELECT id, detail FROM receipts
    WHERE discord_id IS NULL AND kind=?
      AND json_extract(detail, '$.packet.id')=?
      AND json_extract(detail, '$.packet.armKey')=?
      AND json_extract(detail, '$.packet.triggerKey')=? ORDER BY id`).all(
    WATCHER_NOTICE_RECEIPTS.TRIGGER, packet.id, packet.armKey, packet.triggerKey
  ) as Array<{ id: number; detail: unknown }>;
}

function findNotice(state: WatcherState, armKey: string, triggerKey: string, deps: WatcherNoticeDependencies): FoundWatcherNotice | null {
  const rows = state.db.prepare(`SELECT discord_id, id, detail, created_at FROM receipts
    WHERE discord_id IS NOT NULL AND kind=?
      AND json_extract(detail, '$.packet.armKey')=?
      AND json_extract(detail, '$.packet.triggerKey')=? ORDER BY id`).all(
    WATCHER_NOTICE_RECEIPTS.PUBLICATION, armKey, triggerKey
  ) as Array<{ discord_id: unknown; id: number; detail: unknown; created_at: string }>;
  for (const row of rows) {
    if (typeof row.discord_id !== 'string') throw new deps.StateCorruptError('watcher notice publication receipt is malformed');
    const detail = parseDetail(row.detail);
    const packet = detail?.packet;
    try { validateWatcherNotice(packet); } catch { throw new deps.StateCorruptError('watcher notice publication receipt is malformed'); }
    return {
      messageId: row.discord_id,
      provenance: {
        packet,
        authorId: typeof detail?.authorId === 'string' ? detail.authorId : '',
        receiptId: Number(row.id),
        recordedAt: row.created_at
      }
    };
  }
  const receipts = state.db.prepare(`SELECT discord_id, id, detail, created_at FROM receipts
    WHERE discord_id IS NOT NULL AND kind=?
      AND json_extract(detail, '$.packet.armKey')=?
      AND json_extract(detail, '$.packet.triggerKey')=? ORDER BY id`).all(
    WATCHER_NOTICE_RECEIPTS.PROVENANCE, armKey, triggerKey
  ) as Array<{ discord_id: unknown; id: number; detail: unknown; created_at: string }>;
  for (const row of receipts) {
    if (typeof row.discord_id !== 'string') throw new deps.StateCorruptError('watcher notice receipt is malformed');
    const detail = parseDetail(row.detail);
    const packet = detail?.packet;
    try { validateWatcherNotice(packet); } catch { throw new deps.StateCorruptError('watcher notice receipt is malformed'); }
    return {
      messageId: row.discord_id,
      provenance: {
        packet,
        authorId: typeof detail?.authorId === 'string' ? detail.authorId : '',
        receiptId: Number(row.id),
        recordedAt: row.created_at
      }
    };
  }
  return null;
}

function publicationReceipt(state: WatcherState, messageId: string, packet: WatcherNotice): { id: number; detail: Record<string, unknown> } | null {
  const rows = state.db.prepare(`SELECT id, detail FROM receipts
    WHERE discord_id=? AND kind=? ORDER BY id`).all(messageId, WATCHER_NOTICE_RECEIPTS.PUBLICATION) as Array<{ id: number; detail: unknown }>;
  for (const row of rows) {
    const detail = parseDetail(row.detail);
    if (detail && detail.noticeId === packet.id && detail.armKey === packet.armKey && detail.triggerKey === packet.triggerKey) {
      return { id: Number(row.id), detail };
    }
  }
  return null;
}

function emptyReplyCustody(state: WatcherState, message: WatcherMessage): boolean {
  return (message.replyText === null || message.replyText === undefined) &&
    (message.replyNonce === null || message.replyNonce === undefined) &&
    (message.replyMessageId === null || message.replyMessageId === undefined) &&
    message.replyNextPart === 0 && state.listReplyParts(message.id).length === 0;
}

export function createWatcherNoticeHandlers(deps: WatcherNoticeDependencies) {
  function getWatcherNoticeArm(state: WatcherState, armKey: string): WatcherNoticeArm | null {
    return getArm(state, armKey, deps);
  }

  function findWatcherNotice(state: WatcherState, armKey: string, triggerKey: string): FoundWatcherNotice | null {
    deps.assertText(armKey, 'armKey', 256);
    deps.assertText(triggerKey, 'triggerKey', 256);
    return findNotice(state, armKey, triggerKey, deps);
  }

  function armWatcherNotice(state: WatcherState, input: WatcherNoticeArmInput): Record<string, unknown> {
    deps.assertText(input.armKey, 'armKey', 256);
    deps.assertText(input.parentChannelId, 'parentChannelId', 128);
    deps.assertText(input.childChannelId, 'childChannelId', 128);
    deps.assertUuid(input.nativeId);
    if (input.provider !== WATCHER_NOTICE_PROVIDERS.CLAUDE) throw new deps.BindingError('watcher notices require a Claude owner');
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new deps.StaleGenerationError('invalid watcher notice generation');
    if (!input.caller || input.caller.harness !== 'claude-code' || input.caller.sessionId !== input.nativeId ||
        (input.caller.threadId !== undefined && input.caller.threadId !== input.nativeId)) {
      throw new deps.AuthorizationError('watcher notice arm requires the current Claude caller identity');
    }
    const config = state.requireConfig();
    return state.transaction(() => {
      const binding = state.getBinding(input.parentChannelId);
      if (!binding || !binding.active || binding.provider !== WATCHER_NOTICE_PROVIDERS.CLAUDE || binding.guildId !== config.guildId ||
          binding.nativeId !== input.nativeId || binding.generation !== input.generation) {
        throw new deps.StaleGenerationError('watcher notice arm owner is stale');
      }
      const source = addressFromBinding(binding);
      const route = state.getMessageRoute(input.childChannelId);
      if (!route?.enrollment?.active || route.enrollment.threadId !== input.childChannelId ||
          route.enrollment.parentChannelId !== input.parentChannelId || route.enrollment.guildId !== config.guildId ||
          !sameBinding(route.binding, {
            armKey: input.armKey,
            authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY,
            provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
            operatorId: config.operatorId,
            source,
            target: { ...source, channelId: input.childChannelId },
            workspace: binding.workspace,
            endpoint: binding.endpoint || null,
            sessionRoot: binding.sessionRoot || null,
            conductorId: binding.conductorId || null,
            repoKey: binding.repoKey || null,
            generation: binding.generation,
            createdAt: deps.now()
          }) || !route.ready) {
        throw new deps.StaleGenerationError('watcher notice arm child route is not ready');
      }
      const target = { ...source, channelId: input.childChannelId };
      const arm: WatcherNoticeArm = {
        armKey: input.armKey,
        authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY,
        provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
        operatorId: config.operatorId,
        source,
        target,
        workspace: binding.workspace,
        endpoint: binding.endpoint || null,
        sessionRoot: binding.sessionRoot || null,
        conductorId: binding.conductorId || null,
        repoKey: binding.repoKey || null,
        generation: binding.generation,
        createdAt: deps.now()
      };
      const existing = getArm(state, input.armKey, deps);
      if (existing) {
        if (!sameArm(existing, arm)) throw new deps.BindingError('watcher notice arm key conflicts with frozen owner identity');
        return { armed: false, duplicate: true, arm: existing };
      }
      state.receipt(null, WATCHER_NOTICE_RECEIPTS.ARM, {
        journal: WATCHER_NOTICE_JOURNAL,
        authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY,
        provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
        armKey: arm.armKey,
        operatorId: arm.operatorId,
        source: arm.source,
        target: arm.target,
        workspace: arm.workspace,
        endpoint: arm.endpoint,
        sessionRoot: arm.sessionRoot,
        conductorId: arm.conductorId,
        repoKey: arm.repoKey,
        generation: arm.generation,
        caller: { harness: 'claude-code', sessionId: input.caller.sessionId }
      });
      return { armed: true, duplicate: false, arm: getArm(state, input.armKey, deps) };
    });
  }

  function authorizeWatcherNoticeSend(state: WatcherState, packet: WatcherNotice): { arm: WatcherNoticeArm; binding: WatcherBinding; route: WatcherRoute } {
    validateWatcherNotice(packet);
    const arm = getArm(state, packet.armKey, deps);
    if (!arm) throw new deps.AuthorizationError('watcher notice arm is unknown');
    if (!sameWatcherAddress(packet.source, arm.source) || !sameWatcherAddress(packet.target, arm.target) ||
        packet.kind !== WATCHER_NOTICE_KIND.NOTICE) {
      throw new deps.BindingError('watcher notice does not match its frozen arm');
    }
    const current = currentArmRoute(state, arm, true, deps);
    return { arm, ...current };
  }

  function recordWatcherNoticeTrigger(state: WatcherState, packet: WatcherNotice): { duplicate: boolean; packet: WatcherNotice; receiptId?: number } {
    const authorized = authorizeWatcherNoticeSend(state, packet);
    return state.transaction(() => {
      const rows = triggerRows(state, packet);
      for (const row of rows) {
        const detail = parseDetail(row.detail);
        const previous = detail?.packet;
        if (!previous || typeof previous !== 'object') throw new deps.StateCorruptError('watcher notice trigger receipt is malformed');
        try { validateWatcherNotice(previous); } catch { throw new deps.StateCorruptError('watcher notice trigger receipt is malformed'); }
        if (!sameNotice(previous, packet) || !sameWatcherNotice(previous, packet)) throw new deps.BindingError('watcher notice trigger key conflicts with frozen content');
        return { duplicate: true, packet, receiptId: Number(row.id) };
      }
      state.receipt(null, WATCHER_NOTICE_RECEIPTS.TRIGGER, {
        journal: WATCHER_NOTICE_JOURNAL,
        armKey: packet.armKey,
        triggerKey: packet.triggerKey,
        packet,
        channelId: authorized.binding.channelId,
        deliveryChannelId: authorized.route.deliveryChannelId,
        provider: authorized.binding.provider,
        nativeId: authorized.binding.nativeId,
        generation: authorized.binding.generation
      });
      return { duplicate: false, packet };
    });
  }

  function authorizeWatcherNoticePublication(state: WatcherState, packet: WatcherNotice, event: WatcherNoticePublicationEvent): WatcherNoticeArm {
    validateWatcherNotice(packet);
    if (!event.isBot || event.guildId !== packet.target.guildId || event.channelId !== packet.target.channelId) {
      throw new deps.AuthorizationError('watcher notice publication target is invalid');
    }
    const arm = getArm(state, packet.armKey, deps);
    if (!arm || !sameWatcherAddress(packet.source, arm.source) || !sameWatcherAddress(packet.target, arm.target)) {
      throw new deps.StaleGenerationError('watcher notice publication arm is stale');
    }
    const current = currentArmRoute(state, arm, false, deps);
    if (current.route.deliveryChannelId !== packet.target.channelId) throw new deps.StaleGenerationError('watcher notice publication child is stale');
    return arm;
  }

  function consumeWatcherNotice(state: WatcherState, input: WatcherNoticeConsumeInput): Record<string, unknown> {
    deps.assertText(input.messageId, 'messageId', 128);
    deps.assertUuid(input.nativeId);
    if (input.provider !== WATCHER_NOTICE_PROVIDERS.CLAUDE) throw new deps.BindingError('watcher notice consumption requires Claude');
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new deps.StaleGenerationError('invalid watcher notice generation');
    if (input.channelId !== undefined && input.channelId !== null) deps.assertText(input.channelId, 'channelId', 128);
    return state.transaction(() => {
      const message = state.getMessage(input.messageId);
      if (!message) throw new deps.BindingError('message is unknown');
      if (message.provider !== input.provider || message.nativeId !== input.nativeId || message.generation !== input.generation) {
        throw new deps.StaleGenerationError('watcher notice consumption identity is stale');
      }
      if (state.isInteractionMessage(input.messageId) || message.decisionResult) {
        throw new deps.BindingError('watcher notice consumption does not apply to interaction or decision messages');
      }
      const provenance = state.getWatcherNotice(input.messageId);
      const packet = provenance?.packet;
      if (!provenance || !packet) throw new deps.AuthorizationError('watcher notice provenance is missing');
      const check = state.currentMessageBinding(message);
      if (!check.identity) throw new deps.StaleGenerationError('watcher notice route is stale');
      if (!check.current) throw new deps.AuthorizationError('watcher notice owner is no longer current');
      if (input.channelId !== undefined && input.channelId !== null && input.channelId !== message.channelId && input.channelId !== check.deliveryChannelId) {
        throw new deps.BindingError('watcher notice consumption channel does not match the current route');
      }
      const binding = check.binding;
      if (!binding) throw new deps.StateCorruptError('watcher notice current binding is missing');
      const target = {
        guildId: binding.guildId,
        channelId: check.deliveryChannelId || message.deliveryChannelId || message.channelId,
        provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
        nativeId: binding.nativeId,
        generation: binding.generation
      } as WatcherAddress;
      if (!sameWatcherAddress(packet.target, target) || packet.source.channelId !== message.channelId || packet.source.guildId !== message.guildId) {
        throw new deps.StaleGenerationError('watcher notice target is stale');
      }
      const arm = getArm(state, packet.armKey, deps);
      if (!arm || !sameWatcherAddress(packet.source, arm.source) || !sameWatcherAddress(packet.target, arm.target)) {
        throw new deps.StaleGenerationError('watcher notice arm is stale');
      }
      currentArmRoute(state, arm, false, deps);
      const publication = publicationReceipt(state, message.id, packet);
      if (!publication) throw new deps.BindingError('watcher notice requires its original child publication');
      if (!state.hasNativeAcknowledgment(message)) throw new deps.BindingError('watcher notice requires a matching native acknowledgment');
      if (!emptyReplyCustody(state, message)) throw new deps.BindingError('watcher notice requires empty reply custody');
      const filePreparation = state.nativeReplyFilePreparation(message.id);
      if (filePreparation?.phase === deps.NATIVE_REPLY_FILE_PHASES.PREPARING ||
          filePreparation?.phase === deps.NATIVE_REPLY_FILE_PHASES.ADMITTED) {
        throw new deps.BindingError('watcher notice requires native reply file custody to be recorded or explicitly released');
      }
      const consumedRows = state.db.prepare(`SELECT id, detail FROM receipts
        WHERE discord_id=? AND kind=? ORDER BY id DESC`).all(message.id, WATCHER_NOTICE_RECEIPTS.CONSUMED) as Array<{ id: number; detail: unknown }>;
      const previous = consumedRows.map(row => ({ ...row, detail: parseDetail(row.detail) })).find(row =>
        row.detail?.noticeId === packet.id && row.detail?.armKey === packet.armKey && row.detail?.triggerKey === packet.triggerKey &&
        row.detail?.provider === input.provider && row.detail?.nativeId === input.nativeId && row.detail?.generation === input.generation
      );
      if (message.state === deps.MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST) {
        if (previous) {
          return { consumed: false, duplicate: true, receiptId: Number(previous.id), message, evidence: previous.detail?.evidence || null };
        }
        throw new deps.BindingError('watcher notice is already finalized');
      }
      if (consumedRows.length) throw new deps.StateCorruptError('watcher notice consumption receipt exists before terminal state');
      if (message.state !== deps.MESSAGE_STATES.SUBMITTED) {
        throw new deps.BindingError(`watcher notice consumption requires submitted state, got ${message.state}`);
      }
      const evidence = {
        kind: WATCHER_NOTICE_EVIDENCE_KIND,
        publicationReceiptId: publication.id,
        provenanceReceiptId: provenance.receiptId || null,
        noticeId: packet.id,
        armKey: packet.armKey,
        triggerKey: packet.triggerKey
      };
      const updated = state.db.prepare('UPDATE messages SET state=?, error=NULL, updated_at=? WHERE discord_id=? AND state=?')
        .run(deps.MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST, deps.now(), message.id, deps.MESSAGE_STATES.SUBMITTED);
      if (Number(updated.changes) !== 1) throw new deps.StateCorruptError('watcher notice state changed concurrently');
      state.receipt(message.id, WATCHER_NOTICE_RECEIPTS.CONSUMED, {
        journal: WATCHER_NOTICE_JOURNAL,
        authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY,
        disposition: WATCHER_NOTICE_RECEIPTS.CONSUMED,
        noticeId: packet.id,
        armKey: packet.armKey,
        triggerKey: packet.triggerKey,
        provider: input.provider,
        nativeId: input.nativeId,
        generation: input.generation,
        channelId: message.channelId,
        deliveryChannelId: check.deliveryChannelId,
        evidence
      });
      return { consumed: true, duplicate: false, receiptId: null, message: state.getMessage(message.id), evidence };
    });
  }

  return {
    armWatcherNotice,
    authorizeWatcherNoticePublication,
    authorizeWatcherNoticeSend,
    consumeWatcherNotice,
    findWatcherNotice,
    getWatcherNoticeArm,
    recordWatcherNoticeTrigger
  };
}
