import { sameAddress, validateAgentMessage, KINDS, type AgentAddress, type AgentMessage } from '../agent-message';

export const AGENT_ROUTING_VERSION = 2;

export function isLegacyAgentReceipt(detail: unknown): boolean {
  return Boolean(detail && typeof detail === 'object' && !Object.hasOwn(detail, 'routingVersion'));
}

function sameOwner(left: AgentAddress, right: AgentAddress): boolean {
  return sameAddress({ ...left, channelId: right.channelId }, right);
}

export function isAgentSourcePromotion(original: unknown, packet: unknown, parentChannelId: string): original is AgentMessage {
  try { validateAgentMessage(original); validateAgentMessage(packet); }
  catch { return false; }
  return original.source.channelId === parentChannelId && packet.source.channelId !== parentChannelId &&
    sameOwner(packet.source, original.source) && sameAddress(packet.target, original.target) &&
    packet.id === original.id && packet.kind === original.kind && packet.replyTo === original.replyTo && packet.text === original.text;
}

export function isLegacyChildResult(packet: AgentMessage, request: AgentMessage, requestTarget: unknown,
  childRouteProven = false): boolean {
  return childRouteProven && packet.kind === KINDS.RESULT && packet.replyTo === request.id && sameAddress(packet.target, request.source) &&
    sameAddress(requestTarget, request.target) && packet.source.channelId !== request.target.channelId &&
    sameOwner(packet.source, request.target);
}
