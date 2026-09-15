import * as crypto from 'node:crypto';
import { KINDS } from '../../agent-message';
import { COURIER_SOURCE_KINDS, ENVELOPE_TYPE } from './constants';
import type {
  CourierDispatchInput,
  CourierEnvelope,
  CourierMessage,
  CourierRoute,
  CourierSource
} from './types';

function sourceFor(message: CourierMessage): CourierSource {
  if (message.agentMessage) {
    return {
      kind: COURIER_SOURCE_KINDS.AGENT,
      authorId: message.authorId || null,
      packet: { ...message.agentMessage },
      wire: message.content
    };
  }
  return {
    kind: COURIER_SOURCE_KINDS.HUMAN,
    authorId: message.authorId || '',
    isBot: false,
    content: message.content,
    attachments: [...(message.attachments || [])]
  };
}

function sourceDestination(message: CourierMessage): { guildId: string; channelId: string } {
  return { guildId: message.guildId, channelId: message.deliveryChannelId };
}

function payloadBody(message: CourierMessage, input: CourierDispatchInput): Record<string, unknown> {
  return {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    deliveryChannelId: message.deliveryChannelId,
    sourceDestination: sourceDestination(message),
    source: sourceFor(message),
    wire: message.content,
    packet: message.agentMessage ? { ...message.agentMessage } : null,
    prompt: input.prompt,
    observerCursor: input.observerCursor || null
  };
}

export function payloadHash(message: CourierMessage, input: CourierDispatchInput): string {
  return crypto.createHash('sha256').update(JSON.stringify(payloadBody(message, input))).digest('hex');
}

export function attemptKey(message: CourierMessage, route: CourierRoute, hash: string): string {
  return JSON.stringify({
    messageId: message.id,
    routeId: route.routeId,
    routeGeneration: route.routeGeneration,
    payloadHash: hash,
    sourceKind: message.agentMessage ? COURIER_SOURCE_KINDS.AGENT : COURIER_SOURCE_KINDS.HUMAN,
    source: message.agentMessage?.source || { authorId: message.authorId, channelId: message.deliveryChannelId },
    target: message.agentMessage?.target || null,
    destination: sourceDestination(message)
  });
}

export function attemptId(key: string): string {
  return `courier-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 48)}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function createEnvelope(
  message: CourierMessage,
  route: CourierRoute,
  id: string,
  hash: string,
  input: CourierDispatchInput
): CourierEnvelope {
  if (message.agentMessage && ![KINDS.REQUEST, KINDS.RESULT].includes(message.agentMessage.kind)) {
    throw new Error('courier packet kind is unsupported');
  }
  if (typeof input.prompt !== 'string' || input.prompt.length === 0) {
    throw new Error('courier forwarded prompt is missing');
  }
  const source = sourceFor(message);
  const body = {
    type: ENVELOPE_TYPE,
    attemptId: id,
    messageId: message.id,
    route: { routeId: route.routeId, routeGeneration: route.routeGeneration },
    recipient: { threadId: route.courier.recipientThreadId, hostId: route.courier.hostId },
    courier: { ...route.courier },
    parent: {
      guildId: message.guildId,
      channelId: message.channelId,
      provider: message.provider,
      nativeId: message.nativeId,
      generation: message.generation
    },
    deliveryChannelId: message.deliveryChannelId,
    sourceDestination: sourceDestination(message),
    source,
    packet: message.agentMessage ? { ...message.agentMessage } : null,
    wire: message.content,
    payloadHash: hash,
    prompt: input.prompt,
    observerCursor: input.observerCursor ? { ...input.observerCursor } : null
  } satisfies CourierEnvelope;
  return deepFreeze(body);
}
