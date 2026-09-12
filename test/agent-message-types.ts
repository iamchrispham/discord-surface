import {
  KINDS,
  PREFIX,
  decodeAgentMessage,
  encodeAgentMessage,
  issueAgentAddress,
  sameAddress,
  validAddress,
  verifyAgentAddress,
  type AgentAddress,
  type AgentAddressEnvelope,
  type AgentMessage,
  type AgentMessageKind
} from '../src/agent-message';

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
  id: 'work-1',
  kind: KINDS.REQUEST,
  source,
  target,
  replyTo: null,
  text: 'Inspect the reported failure.'
};
const kind: AgentMessageKind = KINDS.RESULT;
const wire: string = encodeAgentMessage(packet, 'test-token');
const decoded: AgentMessage | null = decodeAgentMessage(wire, 'test-token', target);
const envelope: AgentAddressEnvelope = issueAgentAddress(target, 'test-token');
const verified: AgentAddress = verifyAgentAddress(envelope, 'test-token');
const unknownValue: unknown = source;

if (validAddress(unknownValue)) {
  const channelId: string = unknownValue.channelId;
  void channelId;
}

const equal: boolean = sameAddress(source, target);

// @ts-expect-error requests cannot carry reply correlation
const requestWithReply: AgentMessage = { ...packet, replyTo: 'result-1' };
// @ts-expect-error results require reply correlation
const resultWithoutReply: AgentMessage = { ...packet, kind: KINDS.RESULT, replyTo: null };

void PREFIX;
void kind;
void decoded;
void verified;
void equal;
void requestWithReply;
void resultWithoutReply;
