export const INTERACTION_ORIGIN = 'interaction-origin' as const;
export const INTERACTION_TRANSPORT = 'interaction-callback' as const;

interface SqlRow {
  [key: string]: unknown;
}

interface SqlStatement {
  all<T extends SqlRow = SqlRow>(...parameters: unknown[]): T[];
  get<T extends SqlRow = SqlRow>(...parameters: unknown[]): T | undefined;
  run(...parameters: unknown[]): unknown;
}

interface InteractionDatabase {
  prepare(sql: string): SqlStatement;
}

interface InteractionBinding {
  active: boolean;
  channelId: string;
  guildId: string;
  provider: string;
  nativeId: string;
  workspace: string;
  sessionRoot?: string | null;
  endpoint?: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  generation: number;
  readiness: string;
}

interface InteractionMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  content: string;
  provider: string;
  nativeId: string;
  generation: number;
  state: string;
}

interface InteractionState {
  db: InteractionDatabase;
  transaction<T>(operation: () => T): T;
  requireConfig(): { guildId: string; operatorId: string };
  getBinding(channelId: string): InteractionBinding | null;
  getMessage(messageId: string): InteractionMessage | null;
  getIntakeWatermark?(channelId: string): { detail?: string | null } | null;
  currentMessageBinding(message: InteractionMessage): { current: boolean; binding?: InteractionBinding | null };
  getTransportReceipt(messageId: string, transport?: string | null): InteractionTransportRecord | null;
  beginTransportReceipt(messageId: string, options: { transport: typeof INTERACTION_TRANSPORT; ownerPid: number; ownerIdentity: unknown }): InteractionTransportRecord & { started: boolean };
  recordTransportReceiptOutcome(messageId: string, outcome: string, detail: Record<string, unknown>, transport?: string | null): InteractionTransportRecord | null;
  receipt(discordId: string | null, kind: string, detail: unknown): void;
  directPostOwnerIdentity?(pid: number): unknown;
  directPostOwnerAlive?(pid: number, expectedIdentity: unknown): boolean;
  ordinaryHandoffPauses?: Set<string>;
}

interface InteractionTransportRecord {
  messageId: string;
  attempt?: Record<string, unknown> | null;
  outcome?: Record<string, unknown> | null;
  started?: boolean;
  reason?: string;
  nonce?: string;
}

export interface InteractionInput {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  content: '/cs' | '/cs full';
  full: boolean;
}

export interface InteractionAcceptance {
  accepted: boolean;
  duplicate?: boolean;
  stale?: boolean;
  reason?: string;
  message?: InteractionMessage | null;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function validText(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function bindingMatchesExpected(binding: InteractionBinding | null, expected: InteractionBinding | null): boolean {
  if (!expected) return Boolean(binding?.active);
  return Boolean(binding && expected && binding.active === expected.active && binding.channelId === expected.channelId &&
    binding.guildId === expected.guildId && binding.provider === expected.provider && binding.nativeId === expected.nativeId &&
    binding.generation === expected.generation && (binding.sessionRoot || null) === (expected.sessionRoot || null) &&
    (binding.conductorId || null) === (expected.conductorId || null) &&
    (binding.repoKey || null) === (expected.repoKey || null));
}

function originDetail(input: InteractionInput, binding: InteractionBinding): Record<string, unknown> {
  return {
    interactionId: input.id,
    command: input.content,
    full: input.full,
    guildId: input.guildId,
    channelId: input.channelId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    conductorId: binding.conductorId || null,
    repoKey: binding.repoKey || null,
    generation: binding.generation
  };
}

function validInput(input: InteractionInput): boolean {
  return Boolean(input && validText(input.id) && validText(input.guildId) && validText(input.channelId) && validText(input.userId) &&
    (input.content === '/cs' || input.content === '/cs full') && typeof input.full === 'boolean' && input.full === (input.content === '/cs full'));
}

export function createInteractionHandlers(): {
  acceptInteraction(state: InteractionState, input: InteractionInput, expectedBinding?: InteractionBinding | null): InteractionAcceptance;
  beginCallback(state: InteractionState, messageId: string): InteractionTransportRecord & { started: boolean };
  recordCallbackOutcome(state: InteractionState, messageId: string, outcome: string, detail?: Record<string, unknown>): InteractionTransportRecord | null;
  isInteractionMessage(state: InteractionState, messageId: string): boolean;
  responseTarget(state: InteractionState, messageId: string): string | null;
  recoverCallbacksInTransaction(state: InteractionState, ownerAlive?: (pid: number, identity: unknown) => boolean): number;
} {
  return {
    acceptInteraction(state, input, expectedBinding = null) {
      if (!validInput(input)) return { accepted: false, reason: 'invalid-interaction' };
      const config = state.requireConfig();
      return state.transaction(() => {
        const binding = state.getBinding(input.channelId);
        if (!bindingMatchesExpected(binding, expectedBinding)) return { accepted: false, stale: true, reason: 'stale-binding' };
        if (!binding?.active) return { accepted: false, reason: 'inactive-binding' };
        if (input.guildId !== config.guildId || input.userId !== config.operatorId) return { accepted: false, reason: 'unauthorized-interaction' };
        if (state.ordinaryHandoffPauses?.has(input.channelId) || state.getIntakeWatermark?.(input.channelId)?.detail === 'ordinary handoff fence') {
          return { accepted: false, reason: 'handoff-intake-paused' };
        }
        if (!binding || binding.guildId !== config.guildId || binding.channelId !== input.channelId) return { accepted: false, reason: 'unknown-binding' };
        if (binding.readiness !== 'ready') return { accepted: false, reason: 'binding-not-ready' };
        const existing = state.getMessage(input.id);
        if (existing) return { accepted: false, duplicate: true, reason: 'duplicate-interaction', message: existing };
        const timestamp = new Date().toISOString();
        state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.id, input.guildId, input.channelId, input.userId, input.content, binding.provider, binding.nativeId,
          binding.workspace, binding.endpoint || null, binding.conductorId || null, binding.repoKey || null,
          binding.generation, 'accepted', timestamp, timestamp
        );
        state.receipt(input.id, INTERACTION_ORIGIN, originDetail(input, binding));
        return { accepted: true, message: state.getMessage(input.id) };
      });
    },

    beginCallback(state, messageId) {
      if (!validText(messageId)) throw new Error('messageId must be a non-empty string of at most 128 characters');
      const ownerPid = process.pid;
      const ownerIdentity = typeof state.directPostOwnerIdentity === 'function'
        ? state.directPostOwnerIdentity(ownerPid)
        : null;
      return state.beginTransportReceipt(messageId, {
        transport: INTERACTION_TRANSPORT,
        ownerPid,
        ownerIdentity
      });
    },

    recordCallbackOutcome(state, messageId, outcome, detail = {}) {
      return state.recordTransportReceiptOutcome(messageId, outcome, { transport: INTERACTION_TRANSPORT, ...detail }, INTERACTION_TRANSPORT);
    },

    isInteractionMessage(state, messageId) {
      return Boolean(state.db.prepare('SELECT 1 FROM receipts WHERE discord_id=? AND kind=? LIMIT 1').get(messageId, INTERACTION_ORIGIN));
    },

    responseTarget(state, messageId) {
      const receipt = state.getTransportReceipt(messageId, INTERACTION_TRANSPORT);
      const target = receipt?.outcome?.responseMessageId;
      return validText(target) ? target : null;
    },

    recoverCallbacksInTransaction(state, ownerAlive = (pid, identity) => state.directPostOwnerAlive?.(pid, identity) || false) {
      const rows = state.db.prepare(`SELECT attempt.discord_id AS discord_id, attempt.detail AS detail
        FROM receipts attempt
        LEFT JOIN receipts outcome ON outcome.discord_id=attempt.discord_id
          AND outcome.kind=? AND outcome.id>attempt.id
          AND json_extract(outcome.detail, '$.transport')=?
        WHERE attempt.kind=? AND json_extract(attempt.detail, '$.transport')=? AND outcome.id IS NULL
        ORDER BY attempt.id`).all<{ discord_id: string; detail: unknown }>('transport-receipt-outcome', INTERACTION_TRANSPORT, 'transport-receipt-attempt', INTERACTION_TRANSPORT);
      let recovered = 0;
      for (const row of rows) {
        const detail = parseJson(row.detail);
        const pid = Number(detail.ownerPid);
        if (Number.isInteger(pid) && pid > 0 && ownerAlive(pid, detail.ownerIdentity)) continue;
        state.receipt(row.discord_id, 'transport-receipt-outcome', {
          ...detail,
          transport: INTERACTION_TRANSPORT,
          outcome: 'unknown',
          terminal: true,
          visibility: 'unknown',
          reason: 'process stopped before interaction callback outcome'
        });
        recovered += 1;
      }
      return recovered;
    }
  };
}
