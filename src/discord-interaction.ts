const CALLBACK_TYPE = 4;
const DEFERRED_UPDATE_MESSAGE_CALLBACK_TYPE = 6;
const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const MESSAGE_COMPONENT_INTERACTION_TYPE = 3;
const CHAT_INPUT_COMMAND_TYPE = 1;
const BOOLEAN_OPTION_TYPE = 5;
const BUTTON_COMPONENT_TYPE = 2;
const EPHEMERAL_MESSAGE_FLAG = 64;
const DEFAULT_CALLBACK_TIMEOUT_MS = 2500;

export const INTERACTION_OUTCOMES = Object.freeze({
  SENT: 'sent',
  NOT_SENT: 'not_sent',
  REJECTED: 'rejected',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN: 'unknown'
} as const);

export type InteractionOutcome = typeof INTERACTION_OUTCOMES[keyof typeof INTERACTION_OUTCOMES];

export const COMPONENT_TYPES = Object.freeze({
  BUTTON: BUTTON_COMPONENT_TYPE
} as const);

export type ComponentType = typeof COMPONENT_TYPES[keyof typeof COMPONENT_TYPES];

export const DEFERRED_UPDATE_CALLBACK_TYPE = DEFERRED_UPDATE_MESSAGE_CALLBACK_TYPE;
export const DECISION_BUTTON_LIMIT = 25;

export interface DecisionCustomId {
  presentationId: string;
  selectedIndex: number;
}

export function decodeDecisionCustomId(value: unknown): DecisionCustomId | null {
  if (!text(value, 100)) return null;
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'd') return null;
  const [, presentationId, indexText] = parts;
  if (!text(presentationId, 48) || /[^A-Za-z0-9._-]/.test(presentationId)) return null;
  const selectedIndex = Number(indexText);
  if (!Number.isInteger(selectedIndex) || String(selectedIndex) !== indexText ||
    selectedIndex < 0 || selectedIndex >= DECISION_BUTTON_LIMIT) return null;
  return { presentationId, selectedIndex };
}

export function encodeDecisionCustomId(presentationId: string, selectedIndex: number): string {
  if (typeof presentationId !== 'string' || !Number.isInteger(selectedIndex)) {
    throw new Error('invalid decision button identity');
  }
  const encoded = `d:${presentationId}:${selectedIndex}`;
  if (!decodeDecisionCustomId(encoded)) throw new Error('invalid decision button identity');
  return encoded;
}

export const CS_COMMAND = Object.freeze({
  name: 'cs',
  description: 'Show the conductor status board',
  type: CHAT_INPUT_COMMAND_TYPE,
  options: Object.freeze([{
    name: 'full',
    description: 'Include full lane details',
    type: BOOLEAN_OPTION_TYPE,
    required: false
  }])
} as const);

export const SAVED_CALLBACK_CONTENT = '/cs received';

interface InteractionOption {
  name?: unknown;
  type?: unknown;
  value?: unknown;
}

export interface ParsedCsInteraction {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  token: string;
  applicationId: string | null;
  full: boolean;
  content: '/cs' | '/cs full';
}

export interface ParsedComponentInteraction {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  token: string;
  applicationId: string;
  messageId: string;
  componentType: ComponentType;
  customId: string;
  presentationId: string;
}

export interface InteractionCallbackFetchResponse {
  ok?: unknown;
  status?: unknown;
  headers?: unknown;
  json?: () => Promise<unknown>;
  body?: { cancel?: () => Promise<unknown> | unknown } | null;
}

export type InteractionFetch = (url: string, init: {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<InteractionCallbackFetchResponse>;

export interface InteractionCallbackResult {
  outcome: InteractionOutcome;
  responseMessageId?: string;
  statusCode?: number;
  reason?: string;
  visibility?: 'available' | 'unknown';
  terminal?: boolean;
}

export interface InteractionCommandManager {
  fetch?: (options: { guildId: string }) => Promise<unknown>;
  create?: (command: typeof CS_COMMAND, guildId: string) => Promise<unknown>;
  edit?: (commandId: string, command: typeof CS_COMMAND) => Promise<unknown>;
}

function text(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function optionsOf(interaction: Record<string, unknown>): InteractionOption[] | null {
  const options = interaction.options;
  if (options === undefined || options === null) return [];
  if (typeof options !== 'object' || Array.isArray(options)) return null;
  const data = (options as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data as InteractionOption[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function componentMessageIdOf(interaction: Record<string, unknown>): unknown {
  const message = recordOf(interaction.message);
  return message?.id;
}

function isComponentType(value: unknown): value is ComponentType {
  return value === BUTTON_COMPONENT_TYPE;
}

export function parseCsInteraction(input: unknown, expectedApplicationId: string | null = null): ParsedCsInteraction | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const interaction = input as Record<string, unknown>;
  if (interaction.type !== APPLICATION_COMMAND_INTERACTION_TYPE) return null;
  if (typeof interaction.isChatInputCommand === 'function' && !(interaction.isChatInputCommand as () => unknown).call(interaction)) return null;
  if (interaction.commandName !== 'cs' || !text(interaction.id) || !text(interaction.guildId) || !text(interaction.channelId)) return null;
  const user = interaction.user;
  const userId = user !== null && typeof user === 'object' ? (user as { id?: unknown }).id : null;
  if (!text(userId) || !text(interaction.token, 512)) return null;
  const applicationId = text(interaction.applicationId) ? interaction.applicationId : null;
  if (expectedApplicationId && applicationId !== expectedApplicationId) return null;
  const options = optionsOf(interaction);
  if (!options || options.some(option => !option || typeof option !== 'object' || option.name !== 'full' ||
    (option.type !== undefined && option.type !== BOOLEAN_OPTION_TYPE) || typeof option.value !== 'boolean')) return null;
  if (options.length > 1) return null;
  const full = options[0]?.value === true;
  return {
    id: interaction.id as string,
    guildId: interaction.guildId as string,
    channelId: interaction.channelId as string,
    userId,
    token: interaction.token as string,
    applicationId,
    full,
    content: full ? '/cs full' : '/cs'
  };
}

export function parseComponentInteraction(input: unknown, expectedApplicationId: string | null = null): ParsedComponentInteraction | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const interaction = input as Record<string, unknown>;
  if (interaction.type !== MESSAGE_COMPONENT_INTERACTION_TYPE) return null;
  if (typeof interaction.isMessageComponent === 'function' && !(interaction.isMessageComponent as () => unknown).call(interaction)) return null;
  const componentType = interaction.componentType;
  if (!isComponentType(componentType)) return null;
  if (!text(interaction.id) || !text(interaction.guildId) || !text(interaction.channelId) || !text(interaction.applicationId)) return null;
  const user = recordOf(interaction.user);
  if (!text(user?.id) || !text(interaction.token, 512)) return null;
  const applicationId = interaction.applicationId as string;
  if (expectedApplicationId && applicationId !== expectedApplicationId) return null;
  const messageId = componentMessageIdOf(interaction);
  const customId = interaction.customId;
  if (!text(messageId) || !text(customId, 100)) return null;
  return {
    id: interaction.id as string,
    guildId: interaction.guildId as string,
    channelId: interaction.channelId as string,
    userId: user.id as string,
    token: interaction.token as string,
    applicationId,
    messageId,
    componentType,
    customId,
    // The custom ID is an opaque persisted presentation reference. Admission owns authority checks.
    presentationId: customId
  };
}

function commandValues(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(item => item !== null && typeof item === 'object') as Array<Record<string, unknown>>;
  if (value !== null && typeof value === 'object') {
    const iterable = value as { values?: () => Iterable<unknown> };
    if (typeof iterable.values === 'function') return [...iterable.values()].filter(item => item !== null && typeof item === 'object') as Array<Record<string, unknown>>;
  }
  return [];
}

export async function upsertGuildCsCommand(manager: InteractionCommandManager | null | undefined, guildId: string): Promise<unknown> {
  if (!manager || typeof manager.fetch !== 'function') return null;
  const existing = commandValues(await manager.fetch({ guildId })).find(command => command.name === CS_COMMAND.name &&
    (command.type === undefined || command.type === CHAT_INPUT_COMMAND_TYPE));
  if (existing) {
    if (typeof existing.edit === 'function') return (existing.edit as (command: typeof CS_COMMAND) => Promise<unknown>)(CS_COMMAND);
    if (typeof manager.edit === 'function' && text(existing.id)) return manager.edit(existing.id, CS_COMMAND);
    throw new Error('Discord /cs command cannot be edited');
  }
  if (typeof manager.create !== 'function') throw new Error('Discord application command creation is unavailable');
  return manager.create(CS_COMMAND, guildId);
}

function responseMessageId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const candidates = [
    (record.interaction as Record<string, unknown> | null | undefined)?.response_message_id,
    (record.interaction as Record<string, unknown> | null | undefined)?.responseMessageId,
    (record.resource as Record<string, unknown> | null | undefined)?.id,
    (record.resource as Record<string, unknown> | null | undefined)?.message_id,
    ((record.resource as Record<string, unknown> | null | undefined)?.message as Record<string, unknown> | null | undefined)?.id,
    (record.message as Record<string, unknown> | null | undefined)?.id
  ];
  return candidates.find(candidate => text(candidate)) as string | undefined || null;
}

async function cancelBody(response: InteractionCallbackFetchResponse): Promise<void> {
  try { await response.body?.cancel?.(); } catch {}
}

function responseStatus(response: InteractionCallbackFetchResponse): number | null {
  const status = Number(response.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

type InteractionCallbackRequest =
  | { type: typeof CALLBACK_TYPE; data: Record<string, unknown>; withResponse: true }
  | { type: typeof DEFERRED_UPDATE_MESSAGE_CALLBACK_TYPE; withResponse: false };

interface InteractionCallbackOptions {
  signal?: AbortSignal;
  fetchImpl?: InteractionFetch;
  timeoutMs?: number;
}

async function sendCallbackRequest(
  interaction: Pick<ParsedCsInteraction, 'id' | 'token'>,
  requestSpec: InteractionCallbackRequest,
  { signal, fetchImpl = globalThis.fetch as unknown as InteractionFetch,
    timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS }: InteractionCallbackOptions = {}
): Promise<InteractionCallbackResult> {
  if (signal?.aborted) return { outcome: INTERACTION_OUTCOMES.NOT_SENT, reason: 'callback stopped before request' };
  if (typeof fetchImpl !== 'function') return { outcome: INTERACTION_OUTCOMES.NOT_SENT, reason: 'Discord interaction callback fetch is unavailable' };
  let started = false;
  let timedOut = false;
  const callbackController = new AbortController();
  const relayAbort = () => callbackController.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    started = true;
    const endpoint = `https://discord.com/api/v10/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback${requestSpec.withResponse ? '?with_response=true' : ''}`;
    const body = requestSpec.withResponse
      ? { type: requestSpec.type, data: requestSpec.data }
      : { type: requestSpec.type };
    const request = Promise.resolve().then(() => fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: callbackController.signal
    }));
    const timeout = Number(timeoutMs);
    const boundedTimeout = Number.isFinite(timeout) && timeout > 0
      ? Math.min(timeout, 3000)
      : DEFAULT_CALLBACK_TIMEOUT_MS;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        callbackController.abort();
        reject(new Error('Discord interaction callback deadline exceeded'));
      }, boundedTimeout);
    });
    const response = await Promise.race([request, deadline]);
    const status = responseStatus(response);
    if (response?.ok !== true) {
      await Promise.race([cancelBody(response), deadline]);
      return {
        outcome: status === 429 ? INTERACTION_OUTCOMES.RATE_LIMITED : status !== null && status >= 400 && status < 500 ? INTERACTION_OUTCOMES.REJECTED : INTERACTION_OUTCOMES.UNKNOWN,
        ...(status === null ? {} : { statusCode: status }),
        reason: requestSpec.withResponse ? 'Discord interaction callback request rejected' : 'Discord component callback request rejected'
      };
    }
    if (!requestSpec.withResponse) {
      await Promise.race([cancelBody(response), deadline]);
      return { outcome: INTERACTION_OUTCOMES.SENT, ...(status === null ? {} : { statusCode: status }) };
    }
    let responseBody: unknown = null;
    try { responseBody = await Promise.race([response.json?.() || Promise.resolve(null), deadline]); }
    catch (error) { if (timedOut) throw error; }
    const responseId = responseMessageId(responseBody);
    if (!responseId) {
      await Promise.race([cancelBody(response), deadline]);
      return {
        outcome: INTERACTION_OUTCOMES.UNKNOWN,
        ...(status === null ? {} : { statusCode: status }),
        reason: 'Discord interaction callback response lacks response-message id',
        visibility: 'unknown',
        terminal: true
      };
    }
    await Promise.race([cancelBody(response), deadline]);
    return { outcome: INTERACTION_OUTCOMES.SENT, ...(status === null ? {} : { statusCode: status }), responseMessageId: responseId, visibility: 'available' };
  } catch (error) {
    return {
      outcome: started ? INTERACTION_OUTCOMES.UNKNOWN : INTERACTION_OUTCOMES.NOT_SENT,
      reason: timedOut ? 'Discord interaction callback deadline exceeded' : String((error as { message?: unknown })?.message || error).slice(0, 200)
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

export async function sendInteractionCallback(
  interaction: Pick<ParsedCsInteraction, 'id' | 'token'>,
  { signal, fetchImpl = globalThis.fetch as unknown as InteractionFetch, content = SAVED_CALLBACK_CONTENT,
    ephemeral = false, timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS }: {
    signal?: AbortSignal;
    fetchImpl?: InteractionFetch;
    content?: string;
    ephemeral?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<InteractionCallbackResult> {
  return sendCallbackRequest(interaction, {
    type: CALLBACK_TYPE,
    withResponse: true,
    data: {
      content,
      allowed_mentions: { parse: [] },
      ...(ephemeral ? { flags: EPHEMERAL_MESSAGE_FLAG } : {})
    }
  }, { signal, fetchImpl, timeoutMs });
}

export async function sendComponentCallback(
  interaction: Pick<ParsedComponentInteraction, 'id' | 'token'>,
  { signal, fetchImpl = globalThis.fetch as unknown as InteractionFetch,
    timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS }: {
    signal?: AbortSignal;
    fetchImpl?: InteractionFetch;
    timeoutMs?: number;
  } = {}
): Promise<InteractionCallbackResult> {
  return sendCallbackRequest(interaction, { type: DEFERRED_UPDATE_MESSAGE_CALLBACK_TYPE, withResponse: false }, { signal, fetchImpl, timeoutMs });
}

export { responseMessageId };
