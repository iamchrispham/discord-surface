import type { AgentProvider } from '../agent-message';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DIRECT_POST_FILE_LIMITS,
  DIRECT_POST_FILE_PHASES,
  inspectDirectPostFile,
  removeDirectPostFile,
  stageDirectPostFile,
  stagedDirectPostFilePath,
  type DirectPostFileManifest
} from '../direct-post-file';

export const NATIVE_REPLY_FILE_PREPARATION = 'native-reply-file-preparation';
export const NATIVE_REPLY_FILE_JOURNAL = 'native-reply-file-v1';

export const NATIVE_REPLY_FILE_PHASES = Object.freeze({
  PREPARING: 'preparing',
  ADMITTED: 'admitted',
  RELEASED: 'released'
} as const);

export type NativeReplyFilePhase = typeof NATIVE_REPLY_FILE_PHASES[keyof typeof NATIVE_REPLY_FILE_PHASES];

export interface NativeReplyFilePreparation extends DirectPostFileManifest {
  journal: typeof NATIVE_REPLY_FILE_JOURNAL;
  phase: NativeReplyFilePhase;
  reservesCapacity?: boolean;
  messageId: string;
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  operatorId: string;
  ownerPid: number;
  ownerStartTime: string | null;
  ownerCommand: string | null;
}

export function nativeReplyFilePreparationKey(ownerKind: string, preparationId: string): string {
  return `${ownerKind}\u0000${preparationId}`;
}

interface NativeReplyFileState {
  db: any;
  transaction<T>(fn: () => T): T;
  getMessage(messageId: string): any;
  currentMessageBinding(message: any): any;
  directPostOwnerIdentity(pid: number): any;
  directPostOwnerAlive(pid: number, identity: any): boolean;
  receipt(discordId: string, kind: string, detail: unknown): void;
}

interface NativeReplyFileMessageStates {
  REPLIED: string;
  REPLY_READY: string;
  SUBMITTED: string;
  DISPATCHING: string;
  UNCERTAIN: string;
}

interface NativeReplyFileDependencies {
  BindingError: new (message: string) => Error;
  AuthorizationError: new (message: string) => Error;
  StaleGenerationError: new (message: string) => Error;
  StateCorruptError: new (message: string) => Error;
  MESSAGE_STATES: NativeReplyFileMessageStates;
  DIRECT_POST_FILE_PREPARATION: string;
  NATIVE_ACK_RECEIPT: string;
  REPLY_LIMIT: number;
  assertProvider(provider: unknown): asserts provider is AgentProvider;
  assertText(value: unknown, name: string, max?: number): string;
  assertUuid(value: unknown, name?: string): string;
  parseJson(value: unknown, fallback: unknown): any;
  safeDetail(value: unknown): string;
  now(): string;
}

function preparationReceipts(state: NativeReplyFileState, deps: NativeReplyFileDependencies, messageId: string): any[] {
  const rows = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id')
    .all(messageId, NATIVE_REPLY_FILE_PREPARATION);
  const details = [];
  for (const row of rows) {
    const detail = deps.parseJson(row.detail, null);
    if (!detail || detail.journal !== NATIVE_REPLY_FILE_JOURNAL || !Object.values(NATIVE_REPLY_FILE_PHASES).includes(detail.phase)) {
      throw new deps.StateCorruptError('native reply file preparation receipt is malformed');
    }
    if (typeof detail.preparationId !== 'string' || detail.preparationId.length === 0) {
      throw new deps.StateCorruptError('native reply file preparation receipt has no preparation id');
    }
    details.push(detail);
  }
  return details;
}

function latestPreparation(state: NativeReplyFileState, deps: NativeReplyFileDependencies, messageId: string): any {
  const latestByPreparation = new Map<string, any>();
  for (const detail of preparationReceipts(state, deps, messageId)) latestByPreparation.set(detail.preparationId, detail);
  const preparations = [...latestByPreparation.values()];
  return preparations.filter(detail => detail.phase !== NATIVE_REPLY_FILE_PHASES.RELEASED).at(-1) || preparations.at(-1) || null;
}

function preparationById(state: NativeReplyFileState, deps: NativeReplyFileDependencies, messageId: string, preparationId: string): any {
  const matches = preparationReceipts(state, deps, messageId).filter(detail => detail.preparationId === preparationId);
  return matches.at(-1) || null;
}

function manifestMatchesPreparation(manifest: any, preparation: any): boolean {
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest) &&
    ['preparationId', 'stagedPath', 'filename', 'size', 'sha256', 'caption', 'captionHash']
      .every(key => manifest[key] === preparation[key]);
}

function activePreparationCount(state: NativeReplyFileState, deps: NativeReplyFileDependencies): number {
  const rows = state.db.prepare('SELECT kind, detail FROM receipts WHERE kind IN (?, ?) ORDER BY id')
    .all(deps.DIRECT_POST_FILE_PREPARATION, NATIVE_REPLY_FILE_PREPARATION);
  const latest = new Map<string, any>();
  for (const row of rows) {
    const detail = deps.parseJson(row.detail, null);
    const expectedJournal = row.kind === NATIVE_REPLY_FILE_PREPARATION ? NATIVE_REPLY_FILE_JOURNAL : 'direct-post-v1';
    if (!detail || detail.journal !== expectedJournal || typeof detail.preparationId !== 'string' || typeof detail.phase !== 'string') {
      throw new deps.StateCorruptError('file preparation receipt is malformed');
    }
    latest.set(nativeReplyFilePreparationKey(row.kind, detail.preparationId), detail);
  }
  return [...latest.values()].filter(detail => detail.reservesCapacity !== false &&
    detail.phase !== DIRECT_POST_FILE_PHASES.RELEASED && detail.phase !== NATIVE_REPLY_FILE_PHASES.RELEASED).length;
}

export function createNativeReplyFileHandlers(deps: NativeReplyFileDependencies) {
  function nativeReplyFilePreparation(state: NativeReplyFileState, messageId: string): any {
    deps.assertText(messageId, 'messageId', 128);
    return latestPreparation(state, deps, messageId);
  }

  function prepareNativeReplyFile(state: NativeReplyFileState, input: {
    provider: AgentProvider; messageId: string; nativeId: string; generation: number;
    stateDir: string; sourcePath: unknown; caption: string;
  }): any {
    const { provider, messageId, nativeId, generation, stateDir, sourcePath, caption } = input;
    deps.assertProvider(provider);
    deps.assertText(messageId, 'messageId', 128);
    deps.assertUuid(nativeId);
    if (!Number.isInteger(generation) || generation < 1) throw new deps.StaleGenerationError('invalid generation');
    deps.assertText(stateDir, 'stateDir', 4096);
    deps.assertText(caption, 'reply caption', deps.REPLY_LIMIT);
    if (!caption.trim()) throw new deps.BindingError('file reply caption must be nonblank');
    const message = state.getMessage(messageId);
    if (!message) throw new deps.StaleGenerationError('native reply is stale');
    const check = state.currentMessageBinding(message);
    if (message.provider !== provider || message.nativeId !== nativeId || message.generation !== generation ||
      !check.binding || check.binding.nativeId !== nativeId || check.binding.generation !== generation || check.binding.provider !== provider) {
      throw new deps.StaleGenerationError('native reply is stale');
    }
    if (!check.current) throw new deps.AuthorizationError('native reply authorization is no longer valid');
    const existing = latestPreparation(state, deps, messageId);
    if (existing?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED) {
      if (existing.captionHash !== crypto.createHash('sha256').update(caption).digest('hex')) {
        throw new deps.BindingError('native reply file request identity conflicts with its admitted custody');
      }
      if (typeof sourcePath === 'string') {
        const resolvedSourcePath = path.resolve(sourcePath);
        try {
          const inspected = inspectDirectPostFile(resolvedSourcePath);
          const bytes = fs.readFileSync(inspected.sourcePath);
          const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          if (inspected.filename !== existing.filename || inspected.size !== existing.size || hash !== existing.sha256) {
            throw new deps.BindingError('native reply file request identity conflicts with its admitted custody');
          }
        } catch (error) {
          if (error instanceof deps.BindingError) throw error;
          if (resolvedSourcePath !== existing.sourcePath) {
            throw new deps.BindingError('native reply file request identity conflicts with its admitted custody');
          }
        }
      }
    }
    if (message.state === deps.MESSAGE_STATES.REPLIED) return existing?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED ? existing : null;
    if (message.state === deps.MESSAGE_STATES.REPLY_READY) {
      if (existing?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED) return existing;
      throw new deps.BindingError('reply is already recorded without file custody');
    }
    if (![deps.MESSAGE_STATES.SUBMITTED, deps.MESSAGE_STATES.DISPATCHING, deps.MESSAGE_STATES.UNCERTAIN].includes(message.state)) {
      throw new deps.BindingError(`reply is not accepted in state ${message.state}`);
    }
    if (existing?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED) return existing;
    if (existing?.phase === NATIVE_REPLY_FILE_PHASES.PREPARING && existing.reservesCapacity !== false) {
      throw new deps.BindingError(`native reply file preparation is already in progress: ${existing.preparationId}`);
    }
    let inspected;
    try { inspected = inspectDirectPostFile(sourcePath); }
    catch (error) { throw new deps.BindingError((error as Error).message); }
    const ownerIdentity = state.directPostOwnerIdentity(process.pid);
    if (!ownerIdentity) throw new deps.BindingError('native reply file preparation owner identity is unavailable');
    const preparationId = crypto.randomUUID();
    const root = path.resolve(stateDir);
    const seed = {
      journal: NATIVE_REPLY_FILE_JOURNAL,
      phase: NATIVE_REPLY_FILE_PHASES.PREPARING,
      preparationId, messageId, sourcePath: inspected.sourcePath,
      stagedPath: stagedDirectPostFilePath(root, preparationId), filename: inspected.filename,
      size: inspected.size, caption, captionHash: crypto.createHash('sha256').update(caption).digest('hex'),
      channelId: message.channelId, guildId: message.guildId, provider, nativeId, generation,
      operatorId: check.config.operatorId, reservesCapacity: true, ...ownerIdentity
    } as any;
    const assertReservationCustody = () => {
      const currentMessage = state.getMessage(messageId);
      if (!currentMessage) throw new deps.StaleGenerationError('native reply is stale');
      const currentCheck = state.currentMessageBinding(currentMessage);
      if (currentMessage.provider !== provider || currentMessage.nativeId !== nativeId || currentMessage.generation !== generation ||
        !currentCheck.binding || currentCheck.binding.nativeId !== nativeId || currentCheck.binding.generation !== generation || currentCheck.binding.provider !== provider) {
        throw new deps.StaleGenerationError('native reply is stale');
      }
      if (!currentCheck.current) throw new deps.AuthorizationError('native reply authorization is no longer valid');
      if (![deps.MESSAGE_STATES.SUBMITTED, deps.MESSAGE_STATES.DISPATCHING, deps.MESSAGE_STATES.UNCERTAIN].includes(currentMessage.state)) {
        throw new deps.BindingError(`reply is not accepted in state ${currentMessage.state}`);
      }
    };
    const capacityExhausted = state.transaction(() => {
      assertReservationCustody();
      const current = latestPreparation(state, deps, messageId);
      if (current?.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED) throw new deps.BindingError('native reply file preparation is already admitted');
      if (current?.phase === NATIVE_REPLY_FILE_PHASES.PREPARING && current.reservesCapacity !== false) {
        throw new deps.BindingError(`native reply file preparation is already in progress: ${current.preparationId}`);
      }
      const sameCapacityRefusal = current?.phase === NATIVE_REPLY_FILE_PHASES.PREPARING &&
        current.reservesCapacity === false &&
        current.sourcePath === seed.sourcePath &&
        current.filename === seed.filename &&
        current.size === seed.size &&
        current.caption === seed.caption &&
        current.captionHash === seed.captionHash &&
        current.channelId === seed.channelId &&
        current.guildId === seed.guildId &&
        current.provider === seed.provider &&
        current.nativeId === seed.nativeId &&
        current.generation === seed.generation &&
        current.operatorId === seed.operatorId;
      const acknowledgment = state.db.prepare('SELECT detail FROM receipts WHERE discord_id=? AND kind=? ORDER BY id DESC LIMIT 1')
        .get(messageId, deps.NATIVE_ACK_RECEIPT);
      const identity = deps.parseJson(acknowledgment?.detail, null);
      if (!identity || identity.provider !== provider || identity.nativeId !== nativeId || identity.generation !== generation) {
        state.receipt(messageId, deps.NATIVE_ACK_RECEIPT, { provider, nativeId, generation, source: 'native-reply-file' });
      }
      if (activePreparationCount(state, deps) >= DIRECT_POST_FILE_LIMITS.maxReservations) {
        if (sameCapacityRefusal) return true;
        state.receipt(messageId, NATIVE_REPLY_FILE_PREPARATION, { ...seed, reservesCapacity: false });
        return true;
      }
      state.receipt(messageId, NATIVE_REPLY_FILE_PREPARATION, seed);
      return false;
    });
    if (capacityExhausted) throw new deps.BindingError('file custody capacity is exhausted');
    let manifest;
    try { manifest = stageDirectPostFile({ sourcePath, stateDir: root, preparationId, caption, captionHash: seed.captionHash }); }
    catch (error) { throw new deps.BindingError(`native reply file preparation ${preparationId} is not admitted: ${(error as Error).message}`); }
    return state.transaction(() => {
      assertReservationCustody();
      const current = latestPreparation(state, deps, messageId);
      if (!current || current.preparationId !== preparationId || current.phase !== NATIVE_REPLY_FILE_PHASES.PREPARING) {
        throw new deps.BindingError('native reply file preparation is no longer open');
      }
      const next = { ...current, ...manifest, phase: NATIVE_REPLY_FILE_PHASES.ADMITTED };
      state.receipt(messageId, NATIVE_REPLY_FILE_PREPARATION, next);
      return next;
    });
  }

  function releaseNativeReplyFilePreparation(state: NativeReplyFileState, messageId: string, preparationId: string, partIndex = 0): any {
    deps.assertText(messageId, 'messageId', 128);
    deps.assertText(preparationId, 'preparationId', 128);
    if (!Number.isInteger(partIndex) || partIndex < 0) throw new deps.BindingError('reply part index is invalid');
    return state.transaction(() => {
      const preparation = preparationById(state, deps, messageId, preparationId);
      if (!preparation) throw new deps.BindingError('native reply file preparation is unknown');
      if (preparation.phase === NATIVE_REPLY_FILE_PHASES.RELEASED) return preparation;
      if (preparation.phase === NATIVE_REPLY_FILE_PHASES.PREPARING) {
        const ownerIdentity = {
          ownerPid: Number(preparation.ownerPid),
          ownerStartTime: typeof preparation.ownerStartTime === 'string' ? preparation.ownerStartTime : null,
          ownerCommand: typeof preparation.ownerCommand === 'string' ? preparation.ownerCommand : null
        };
        if (state.directPostOwnerAlive(ownerIdentity.ownerPid, ownerIdentity)) throw new deps.BindingError('native reply file preparation owner is still active');
      } else if (preparation.phase === NATIVE_REPLY_FILE_PHASES.ADMITTED) {
        const part = state.db.prepare('SELECT state, file_manifest FROM reply_parts WHERE discord_id=? AND part_index=?').get(messageId, partIndex);
        if (!part || part.state !== 'sent' || !part.file_manifest) throw new deps.BindingError('native reply file cleanup requires a sent file part');
        const manifest = deps.parseJson(part.file_manifest, null);
        if (!manifestMatchesPreparation(manifest, preparation)) {
          throw new deps.BindingError('native reply file cleanup manifest does not match the requested preparation');
        }
      } else throw new deps.BindingError('native reply file preparation cannot be cleaned up');
      removeDirectPostFile({ stateDir: path.dirname(path.dirname(preparation.stagedPath)), preparationId: preparation.preparationId, stagedPath: preparation.stagedPath });
      const next = { ...preparation, phase: NATIVE_REPLY_FILE_PHASES.RELEASED, releasedAt: deps.now() };
      state.receipt(messageId, NATIVE_REPLY_FILE_PREPARATION, next);
      return next;
    });
  }

  return { nativeReplyFilePreparation, activeFilePreparationCount: (state: NativeReplyFileState) => activePreparationCount(state, deps), prepareNativeReplyFile, releaseNativeReplyFilePreparation };
}

export function assertNativeReplyFileManifest(manifest: unknown): asserts manifest is DirectPostFileManifest {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('native reply file manifest is invalid');
  const value = manifest as Record<string, unknown>;
  for (const key of ['preparationId', 'stagedPath', 'filename', 'sha256', 'caption', 'captionHash']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) throw new Error(`native reply file manifest ${key} is invalid`);
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0) throw new Error('native reply file manifest size is invalid');
}
