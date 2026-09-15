import {
  COMPONENT_TYPES,
  CS_COMMAND,
  DEFERRED_UPDATE_CALLBACK_TYPE,
  INTERACTION_OUTCOMES,
  decodeDecisionCustomId,
  encodeDecisionCustomId,
  type ParsedComponentInteraction,
  parseCsInteraction,
  parseComponentInteraction,
  responseMessageId,
  sendComponentCallback,
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
const decisionIdentity = decodeDecisionCustomId(encodeDecisionCustomId('canonical-question', 0));
if (decisionIdentity) {
  const savedPresentation: string = decisionIdentity.presentationId;
  const selectedIndex: number = decisionIdentity.selectedIndex;
  void savedPresentation;
  void selectedIndex;
}
// @ts-expect-error The selected index must not be a string.
encodeDecisionCustomId('canonical-question', '0');
// @ts-expect-error The presentation identity must not be a number.
encodeDecisionCustomId(1, 0);
void COMPONENT_TYPES;
const component: ParsedComponentInteraction | null = parseComponentInteraction({
  type: 3,
  id: 'component-id',
  guildId: 'guild-id',
  channelId: 'channel-id',
  applicationId: 'application-id',
  token: 'token',
  user: { id: 'operator-id' },
  message: { id: 'presentation-message-id' },
  componentType: COMPONENT_TYPES.BUTTON,
  customId: 'presentation-reference'
}, 'application-id');
if (component) {
  const componentType: 2 = component.componentType;
  const presentationId: string = component.presentationId;
  void componentType;
  void presentationId;
  void sendComponentCallback(component);
}
const type6: 6 = DEFERRED_UPDATE_CALLBACK_TYPE;
void type6;
void INTERACTION_OUTCOMES;
void INTERACTION_ORIGIN;
void INTERACTION_TRANSPORT;
void responseMessageId({ resource: { id: 'response-id' } });
void sendInteractionCallback;
void upsertGuildCsCommand;
void createInteractionHandlers;
