import { KINDS, type AgentMessage, type AgentAddress } from '../../src/agent-message';
import { AGENT_PRESENTATIONS, agentMessagePreview, type AgentPresentation } from '../../src/agent-presentation';

const source: AgentAddress = {
  guildId: '100',
  channelId: '101',
  provider: 'codex',
  nativeId: '11111111-1111-1111-1111-111111111111',
  generation: 1
};
const target: AgentAddress = {
  guildId: '100',
  channelId: '102',
  provider: 'claude',
  nativeId: '22222222-2222-2222-2222-222222222222',
  generation: 2
};
const packet: AgentMessage = {
  id: 'presentation-types',
  kind: KINDS.REQUEST,
  source,
  target,
  replyTo: null,
  text: 'Inspect the reported failure.'
};

const legacy: AgentPresentation = AGENT_PRESENTATIONS.LEGACY;
const attachment: AgentPresentation = AGENT_PRESENTATIONS.ATTACHMENT;
const preview: string = agentMessagePreview(packet);

// @ts-expect-error presentation values are finite
const unsupported: AgentPresentation = 'json';

void legacy;
void attachment;
void preview;
void unsupported;
