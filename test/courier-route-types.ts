import { KINDS, PROVIDERS, type AgentMessage } from '../src/agent-message';
import {
  COURIER_OUTCOMES,
  COURIER_ROUTE_STATES,
  createCourierRouteHandlers,
  createEnvelope,
  type CourierAttempt,
  type CourierAttemptRecord,
  type CourierDependencies,
  type CourierDispatchInput,
  type CourierEnvelope,
  type CourierIdentity,
  type CourierMessage,
  type CourierOutcome,
  type CourierResultStatus,
  type CourierRoute,
  type RouteMatch,
  type CourierState
} from '../src/state/courier-route';

const parentNativeId = '11111111-1111-1111-1111-111111111111';
const courierNativeId = '22222222-2222-2222-2222-222222222222';
const target = {
  guildId: '100',
  channelId: '200',
  provider: PROVIDERS.CODEX,
  nativeId: parentNativeId,
  generation: 3
};
const courier: CourierIdentity = {
  provider: PROVIDERS.CODEX,
  nativeId: courierNativeId,
  workspace: '/tmp/courier-route-types',
  sessionRoot: '/tmp/courier-route-types/sessions',
  recipientThreadId: '33333333-3333-3333-3333-333333333333',
  hostId: null
};
const route: CourierRoute = {
  schema: 'discord-surface:courier:v1:route',
  routeId: 'route-1',
  routeGeneration: 1,
  status: COURIER_ROUTE_STATES.ACTIVE,
  guildId: target.guildId,
  parentChannelId: '1000',
  deliveryChannelId: target.channelId,
  target,
  courier
};
const packet: AgentMessage = {
  id: 'request-1',
  kind: KINDS.REQUEST,
  source: { ...target, channelId: '300', nativeId: '44444444-4444-4444-4444-444444444444' },
  target,
  replyTo: null,
  text: 'request'
};
const message: CourierMessage = {
  id: 'message-1',
  guildId: target.guildId,
  channelId: target.channelId,
  deliveryChannelId: target.channelId,
  provider: target.provider,
  nativeId: target.nativeId,
  generation: target.generation,
  content: 'wire',
  agentMessage: packet,
  state: 'accepted',
  authorId: 'agent-bot'
};
const input: CourierDispatchInput = {
  routeId: route.routeId,
  prompt: 'forward this prompt',
  observerCursor: null
};
const envelope: CourierEnvelope = createEnvelope(message, route, 'attempt-1', 'hash-1', input);
const attempt: CourierAttempt = {
  attemptId: envelope.attemptId,
  attemptKey: 'attempt-key',
  state: 'claimed',
  messageId: envelope.messageId,
  route: envelope.route,
  payloadHash: envelope.payloadHash,
  courier: envelope.courier,
  recipient: envelope.recipient,
  parent: envelope.parent,
  deliveryChannelId: envelope.deliveryChannelId,
  sourceDestination: envelope.sourceDestination,
  source: envelope.source,
  packet: envelope.packet,
  wire: envelope.wire,
  prompt: envelope.prompt,
  observerCursor: envelope.observerCursor,
  envelope
};
const outcome: CourierOutcome = COURIER_OUTCOMES.SUBMITTED;
const resultStatus: CourierResultStatus = 'claimed';
const routeMatch: RouteMatch = { status: null, route };
const record: CourierAttemptRecord = {
  attempt,
  outcome: { attemptId: attempt.attemptId, outcome }
};
const state = null as unknown as CourierState;
const dependencies = null as unknown as CourierDependencies;
const handlers = createCourierRouteHandlers(dependencies);
handlers.beginCourierAttempt(state, message.id, input);
handlers.authorizeCourierAttempt(state, message.id, attempt.attemptId, input);
handlers.recordCourierOutcome(state, message.id, attempt.attemptId, outcome);
handlers.getCourierAttempt(state, message.id, attempt.attemptId);
handlers.listCourierRoutes(state);
handlers.registerCourierRoute(state, route);
handlers.revokeCourierRoute(state, route.routeId);
handlers.getCourierRoute(state, route.routeId);

// @ts-expect-error courier identities use the shared AgentProvider vocabulary
const invalidCourier: CourierIdentity = { ...courier, provider: 'spark' };

void record;
void resultStatus;
void routeMatch;
void invalidCourier;
