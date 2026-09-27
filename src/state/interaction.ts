import {
  DECISION_REASONS,
  type DecisionInteractionAdmission,
  type DecisionInteractionInput,
  type DecisionResult
} from './decision/types';
import { INTERACTION_ORIGIN, INTERACTION_TRANSPORT } from './interaction/constants';
import {
  bindingMatchesExpected,
  decisionOriginDetail,
  decisionResultForMessage,
  latestOriginDetail,
  originDetail,
  parseJson,
  sameDecisionInteraction,
  validDecisionInput,
  validInput,
  validText
} from './interaction/origin';
import type {
  InteractionAcceptance,
  InteractionAcceptanceOptions,
  InteractionBinding,
  InteractionInput,
  InteractionMessage,
  InteractionState,
  InteractionTransportRecord
} from './interaction/contracts';

export { INTERACTION_ORIGIN, INTERACTION_TRANSPORT, INTERACTION_SOURCES } from './interaction/constants';
export type { InteractionMessage, InteractionInput, InteractionAcceptance, InteractionAcceptanceOptions } from './interaction/contracts';

export function createInteractionHandlers(): {
  acceptInteraction(state: InteractionState, input: InteractionInput, expectedBinding?: InteractionBinding | null, options?: InteractionAcceptanceOptions): InteractionAcceptance;
  acceptDecisionInteraction(state: InteractionState, input: DecisionInteractionInput): DecisionInteractionAdmission;
  decisionResult(state: InteractionState, message: InteractionMessage): DecisionResult | null;
  beginCallback(state: InteractionState, messageId: string): InteractionTransportRecord & { started: boolean };
  recordCallbackOutcome(state: InteractionState, messageId: string, outcome: string, detail?: Record<string, unknown>): InteractionTransportRecord | null;
  isInteractionMessage(state: InteractionState, messageId: string): boolean;
  responseTarget(state: InteractionState, messageId: string): string | null;
  recoverCallbacksInTransaction(state: InteractionState, ownerAlive?: (pid: number, identity: unknown) => boolean): number;
} {
  return {
    decisionResult(state, message) {
      return decisionResultForMessage(state, message);
    },

    acceptDecisionInteraction(state, input) {
      if (!validDecisionInput(input)) return { accepted: false, reason: DECISION_REASONS.INVALID_DECISION_INTERACTION };
      const config = state.requireConfig();
      const binding = state.getBinding(input.channelId);
      if (!bindingMatchesExpected(binding, input.binding)) return { accepted: false, reason: DECISION_REASONS.STALE_BINDING };
      if (!binding?.active) return { accepted: false, reason: DECISION_REASONS.INACTIVE_BINDING };
      if (input.guildId !== config.guildId || input.actorId !== config.operatorId) {
        return { accepted: false, reason: DECISION_REASONS.UNAUTHORIZED_INTERACTION };
      }
      if (state.ordinaryHandoffPauses?.has(input.channelId) || state.getIntakeWatermark?.(input.channelId)?.detail === 'ordinary handoff fence') {
        return { accepted: false, reason: DECISION_REASONS.HANDOFF_INTAKE_PAUSED };
      }
      if (binding.guildId !== config.guildId || binding.channelId !== input.channelId) return { accepted: false, reason: DECISION_REASONS.UNKNOWN_BINDING };
      if (binding.readiness !== state.interactionVocabulary.readyReadiness) return { accepted: false, reason: DECISION_REASONS.BINDING_NOT_READY };
      const existing = state.getMessage(input.interactionId);
      if (existing) {
        const detail = latestOriginDetail(state, input.interactionId);
        if (sameDecisionInteraction(existing, detail, input, binding)) {
          return { accepted: false, duplicate: true, reason: DECISION_REASONS.DUPLICATE_DECISION_INTERACTION };
        }
        return { accepted: false, reason: DECISION_REASONS.INTERACTION_ID_CONFLICT };
      }
      const timestamp = new Date().toISOString();
      state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.interactionId, input.guildId, input.channelId, input.actorId, input.answer, binding.provider, binding.nativeId,
        binding.workspace, binding.endpoint || null, binding.conductorId || null, binding.repoKey || null,
        binding.generation, state.interactionVocabulary.acceptedMessageState, timestamp, timestamp
      );
      state.receipt(input.interactionId, INTERACTION_ORIGIN, decisionOriginDetail(input, binding));
      return { accepted: true };
    },

    acceptInteraction(state, input, expectedBinding = null, options = {}) {
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
        if (binding.readiness !== state.interactionVocabulary.readyReadiness) return { accepted: false, reason: 'binding-not-ready' };
        const existing = state.getMessage(input.id);
        if (existing) return { accepted: false, duplicate: true, reason: 'duplicate-interaction', message: existing };
        const timestamp = new Date().toISOString();
        state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.id, input.guildId, input.channelId, input.userId, input.content, binding.provider, binding.nativeId,
          binding.workspace, binding.endpoint || null, binding.conductorId || null, binding.repoKey || null,
          binding.generation, state.interactionVocabulary.acceptedMessageState, timestamp, timestamp
        );
        state.receipt(input.id, INTERACTION_ORIGIN, originDetail(input, binding));
        const callback = options.claimCallback
          ? state.beginTransportReceipt(input.id, {
            transport: INTERACTION_TRANSPORT,
            ownerPid: options.ownerPid ?? process.pid,
            ownerIdentity: options.ownerIdentity ?? null,
            inTransaction: true
          })
          : null;
        return {
          accepted: true,
          message: state.getMessage(input.id),
          ...(callback ? { callback } : {})
        };
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
      const origin = latestOriginDetail(state, messageId);
      const target = receipt?.outcome?.responseMessageId || origin.responseMessageId || origin.questionMessageId;
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
      const missingAttempts = state.db.prepare(`SELECT origin.discord_id AS discord_id
        FROM receipts origin
        LEFT JOIN receipts attempt ON attempt.discord_id=origin.discord_id
          AND attempt.kind='transport-receipt-attempt'
          AND json_extract(attempt.detail, '$.transport')=?
          AND attempt.id>origin.id
        LEFT JOIN receipts outcome ON outcome.discord_id=origin.discord_id
          AND outcome.kind='transport-receipt-outcome'
          AND json_extract(outcome.detail, '$.transport')=?
          AND outcome.id>origin.id
        WHERE origin.kind=? AND attempt.id IS NULL AND outcome.id IS NULL
        ORDER BY origin.id`).all<{ discord_id: string }>(INTERACTION_TRANSPORT, INTERACTION_TRANSPORT, INTERACTION_ORIGIN);
      for (const row of missingAttempts) {
        state.receipt(row.discord_id, 'transport-receipt-outcome', {
          transport: INTERACTION_TRANSPORT,
          outcome: 'unknown',
          terminal: true,
          visibility: 'unknown',
          reason: 'process stopped before interaction callback attempt'
        });
        recovered += 1;
      }
      return recovered;
    }
  };
}
