import { KINDS, type AgentMessage } from '../agent-message';
import type { CompletionState } from './agent-completion/contracts';

export function hasUniqueRequestTarget(
  state: Pick<CompletionState, 'db'>,
  request: Pick<AgentMessage, 'id' | 'source' | 'target'>,
  candidateReceiptId: number,
  requestReceiptId: number
): boolean {
  // A reused packet id cannot promote child custody across routes.
  const row = state.db.prepare(`SELECT COUNT(DISTINCT json_extract(detail, '$.packet.target.channelId')) AS count
    FROM receipts
    WHERE kind='agent-message'
      AND json_extract(detail, '$.packet.kind')=?
      AND json_extract(detail, '$.packet.id')=?
      AND json_extract(detail, '$.packet.source.guildId')=?
      AND json_extract(detail, '$.packet.source.channelId')=?
      AND json_extract(detail, '$.packet.source.provider')=?
      AND json_extract(detail, '$.packet.source.nativeId')=?
      AND json_extract(detail, '$.packet.source.generation')=?
      AND json_extract(detail, '$.packet.target.guildId')=?
      AND json_extract(detail, '$.packet.target.provider')=?
      AND json_extract(detail, '$.packet.target.nativeId')=?
      AND json_extract(detail, '$.packet.target.generation')=?
      AND (id <= ? OR id = ?)`).get(
    KINDS.REQUEST, request.id,
    request.source.guildId, request.source.channelId, request.source.provider, request.source.nativeId, request.source.generation,
    request.target.guildId, request.target.provider, request.target.nativeId, request.target.generation,
    candidateReceiptId, requestReceiptId
  ) as { count?: number } | undefined;
  return Number(row?.count) === 1;
}
