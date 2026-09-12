import {
  CS_COMMAND,
  INTERACTION_OUTCOMES,
  parseCsInteraction,
  responseMessageId,
  sendInteractionCallback,
  upsertGuildCsCommand
} from '../src/discord-interaction';
import { createInteractionHandlers, INTERACTION_ORIGIN, INTERACTION_TRANSPORT } from '../src/state/interaction';

const parsed = parseCsInteraction({
  type: 2,
  id: 'interaction-id',
  guildId: 'guild-id',
  channelId: 'channel-id',
  commandName: 'cs',
  token: 'token',
  user: { id: 'operator-id' },
  options: { data: [{ name: 'full', type: 5, value: true }] }
});
if (parsed) {
  const command: '/cs' | '/cs full' = parsed.content;
  void command;
}
void CS_COMMAND;
void INTERACTION_OUTCOMES;
void INTERACTION_ORIGIN;
void INTERACTION_TRANSPORT;
void responseMessageId({ resource: { id: 'response-id' } });
void sendInteractionCallback;
void upsertGuildCsCommand;
void createInteractionHandlers;
