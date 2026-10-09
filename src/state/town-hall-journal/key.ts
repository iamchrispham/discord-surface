import { createHash } from 'node:crypto';
import type { TownHallPlan } from '../../peer/town-hall-plan';

const JOURNAL_DOMAIN = 'discord-surface/town-hall-journal/v1';

export function deriveTownHallJournalKey(
  source: TownHallPlan['source'],
  broadcastId: TownHallPlan['broadcastId']
): string {
  return createHash('sha256').update(JSON.stringify([
    JOURNAL_DOMAIN,
    source.guildId,
    source.channelId,
    source.provider,
    source.nativeId,
    source.generation,
    broadcastId
  ])).digest('hex');
}
