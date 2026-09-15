import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROVIDERS, type AgentProvider } from './agent-message';
import type { Readiness } from './topic';
import { DECISION_BUTTON_LIMIT, encodeDecisionCustomId } from './discord-interaction';
import {
  CANONICAL_OPERATIONS, CANONICAL_RUN_STATUSES, resolveCanonicalRoute, runCanonicalOperation,
  type CanonicalRegisterInput, type CanonicalRouteOptions
} from './decision-canonical';
import {
  DECISION_TRANSPORT_OUTCOMES, DecisionError,
  type DecisionBinding, type DecisionBindingInput, type DecisionPresentationInput,
  type DecisionPresentationResult, type DecisionPresentation, type DecisionTransportOutcome
} from './state/decision';

export interface DecisionRequest extends CanonicalRegisterInput {
  channelId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
}

interface ProducerState {
  requireConfig(): { guildId: string; operatorId: string };
  getBinding(channelId: string): DecisionBinding | null;
  isOrdinaryBindingRecord(binding: DecisionBinding): boolean;
  registerDecisionPresentation(input: DecisionPresentationInput): DecisionPresentationResult;
  findDecisionPresentation(input: Pick<DecisionRequest, 'namespace' | 'requestId' | 'channelId' | 'provider' | 'nativeId' | 'generation'>): DecisionPresentation | null;
  recordDecisionPresentationOutcome(id: string, outcome: DecisionTransportOutcome, messageId?: string | null): DecisionPresentation;
}

interface ButtonRow {
  type: 1;
  components: { type: 2; style: 2; label: string; custom_id: string }[];
}

interface MessageOptions {
  token: string;
  channelId: string;
  content: string;
  components: ButtonRow[];
  nonce: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const { resolveDirectBinding } = require('../src/direct-post') as {
  resolveDirectBinding(state: ProducerState, input: DecisionRequest & { ordinary: boolean }): DecisionBinding;
};
const { discordNonce, READINESS } = require('../src/state') as {
  discordNonce(value: string, part: number): string;
  READINESS: Readonly<{ READY: Readiness }>;
};
const { sendDiscordMessage } = require('../src/discord') as { sendDiscordMessage(options: MessageOptions): Promise<{ id: string }> };

const REQUEST_FIELDS = new Set([
  'namespace', 'requestId', 'target', 'head', 'question', 'menu',
  'channelId', 'provider', 'nativeId', 'generation'
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionError('decision requires an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new DecisionError(`invalid decision ${name}`);
  }
  return value;
}

export function parseDecisionRequest(value: unknown): DecisionRequest {
  const input = record(value);
  if (Object.keys(input).some(key => !REQUEST_FIELDS.has(key))) throw new DecisionError('unknown decision request field');
  for (const key of ['namespace', 'requestId', 'target', 'channelId', 'nativeId']) text(input[key], key, 256);
  text(input.question, 'question', 10000);
  if (input.head !== undefined) text(input.head, 'head', 256);
  if (!Object.values(PROVIDERS).includes(input.provider as AgentProvider)) throw new DecisionError('invalid decision provider');
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 1) throw new DecisionError('invalid binding generation');
  if (!Array.isArray(input.menu) || !input.menu.length || input.menu.length > DECISION_BUTTON_LIMIT) {
    throw new DecisionError('decision menu must contain 1 to 25 entries');
  }
  for (const item of input.menu) {
    if (typeof item === 'string') text(item, 'menu key', 80);
    else {
      const entry = record(item);
      if (Object.keys(entry).some(key => key !== 'key' && key !== 'consequence')) throw new DecisionError('unknown menu field');
      text(entry.key, 'menu key', 80);
      if (entry.consequence !== undefined) text(entry.consequence, 'consequence', 2000);
    }
  }
  return input as unknown as DecisionRequest;
}

export function readDecisionRequest(filename: string): DecisionRequest {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new DecisionError('decision request must be a regular file of at most 64 KiB');
    const buffer = Buffer.alloc(65537);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > 65536) throw new DecisionError('decision request exceeds 64 KiB');
    return parseDecisionRequest(JSON.parse(buffer.subarray(0, bytes).toString('utf8')));
  } finally {
    fs.closeSync(fd);
  }
}

function presentationPayload(request: DecisionRequest, raw: unknown) {
  const payload = record(raw);
  if (payload.ok !== true || payload.operation !== CANONICAL_OPERATIONS.REGISTER ||
      payload.namespace !== request.namespace || payload.request_id !== request.requestId || payload.target !== request.target) {
    throw new DecisionError('canonical registration does not match the decision request');
  }
  const qid = text(payload.qid, 'canonical qid', 48);
  const generation = text(payload.question_generation, 'question generation', 128);
  if (!Array.isArray(payload.answers) || !payload.answers.length || payload.answers.length > DECISION_BUTTON_LIMIT) {
    throw new DecisionError('canonical menu does not fit Discord buttons');
  }
  const keys = payload.answers.map(key => text(key, 'canonical key', 80));
  if (new Set(keys).size !== keys.length) throw new DecisionError('canonical menu contains duplicate keys');
  const consequences = payload.consequences === undefined ? {} : record(payload.consequences);
  if (Object.keys(consequences).some(key => !keys.includes(key))) throw new DecisionError('canonical consequence has no answer key');
  const lines = keys.map(key => consequences[key] === undefined ? key : `${key}: ${text(consequences[key], 'canonical consequence', 2000)}`);
  const content = `${request.question}\n\n${lines.join('\n')}`;
  if (content.length > 2000) throw new DecisionError('complete decision exceeds one Discord message');
  const components: ButtonRow[] = [];
  keys.forEach((key, index) => {
    if (index % 5 === 0) components.push({ type: 1, components: [] });
    components[components.length - 1].components.push({ type: 2, style: 2, label: key, custom_id: encodeDecisionCustomId(qid, index) });
  });
  return { qid, generation, keys, content, components };
}

export async function presentDecision({ state, request: raw, token, canonical = {}, signal, authorizeOrdinary, fetchImpl }: {
  state: ProducerState;
  request: unknown;
  token: string;
  canonical?: CanonicalRouteOptions;
  signal?: AbortSignal;
  authorizeOrdinary(binding: DecisionBinding): Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<DecisionPresentation> {
  const request = parseDecisionRequest(raw);
  const candidate = state.getBinding(request.channelId);
  if (!candidate) throw new DecisionError('decision binding is unavailable');
  const ordinary = state.isOrdinaryBindingRecord(candidate);
  const binding = resolveDirectBinding(state, { ...request, ordinary });
  if (binding.readiness !== READINESS.READY) throw new DecisionError('decision binding is not ready');
  if (ordinary) await authorizeOrdinary(binding);
  const previous = state.findDecisionPresentation(request);
  const savedRoute = previous?.canonicalRoute;
  if (savedRoute && ((canonical.executable !== undefined && path.resolve(canonical.executable) !== savedRoute.executable) ||
      (canonical.stateRoot !== undefined && path.resolve(canonical.stateRoot) !== savedRoute.stateRoot))) {
    throw new DecisionError('requested canonical route conflicts with saved presentation');
  }
  const selected = savedRoute ? {
    ...canonical, executable: savedRoute.executable, stateRoot: savedRoute.stateRoot,
    environment: { ...canonical.environment, TELEGRAM_ROOT: savedRoute.telegramRoot }
  } : canonical;
  const route = await resolveCanonicalRoute({ ...selected, signal });
  const registration = await runCanonicalOperation(route, CANONICAL_OPERATIONS.REGISTER, request, { ...selected, signal });
  if (registration.status !== CANONICAL_RUN_STATUSES.COMPLETE || registration.payload?.ok !== true) {
    throw new DecisionError(`canonical registration incomplete: ${registration.error?.message || registration.payload?.error || registration.status}`);
  }
  const body = presentationPayload(request, registration.payload);
  const saved = state.registerDecisionPresentation({
    presentationId: body.qid, namespace: request.namespace, requestId: request.requestId, qid: body.qid, questionGeneration: body.generation,
    target: request.target, guildId: binding.guildId, channelId: binding.channelId,
    binding: { ...binding, provider: request.provider, readiness: READINESS.READY } as DecisionBindingInput,
    keys: body.keys, content: body.content,
    canonicalRoute: { executable: route.replay.executable, stateRoot: route.replay.stateRoot, telegramRoot: route.replay.telegramRoot }
  });
  if (!saved.presentation) throw new DecisionError(`decision presentation refused: ${saved.reason}`);
  if (!saved.created) return saved.presentation;
  let outcome: DecisionTransportOutcome = DECISION_TRANSPORT_OUTCOMES.UNKNOWN;
  let messageId: string | null = null;
  try {
    const current = resolveDirectBinding(state, { ...request, ordinary });
    if (current.readiness !== READINESS.READY) throw Object.assign(new DecisionError('decision binding is no longer ready'), { outcome: DECISION_TRANSPORT_OUTCOMES.NOT_SENT });
    const sent = await sendDiscordMessage({ token, channelId: binding.channelId, content: body.content, components: body.components,
      nonce: discordNonce(`decision-presentation:${binding.channelId}:${body.qid}:${body.generation}`, 0), signal, fetchImpl });
    messageId = text(sent.id, 'sent message id', 128);
    outcome = DECISION_TRANSPORT_OUTCOMES.SENT;
  } catch (error) {
    const value = (error as { outcome?: unknown }).outcome;
    if (Object.values(DECISION_TRANSPORT_OUTCOMES).includes(value as DecisionTransportOutcome)) outcome = value as DecisionTransportOutcome;
  }
  return state.recordDecisionPresentationOutcome(body.qid, outcome, messageId);
}
