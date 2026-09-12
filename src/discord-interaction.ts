const CALLBACK_TYPE = 4;
const APPLICATION_COMMAND_INTERACTION_TYPE = 2;
const CHAT_INPUT_COMMAND_TYPE = 1;
const BOOLEAN_OPTION_TYPE = 5;
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
  if (signal?.aborted) return { outcome: INTERACTION_OUTCOMES.NOT_SENT, reason: 'callback stopped before request' };
  if (typeof fetchImpl !== 'function') return { outcome: INTERACTION_OUTCOMES.NOT_SENT, reason: 'Discord interaction callback fetch is unavailable' };
  let started = false;
  let timedOut = false;
  const callbackController = new AbortController();
  const relayAbort = () => callbackController.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: InteractionCallbackFetchResponse;
  try {
    started = true;
    const request = Promise.resolve().then(() => fetchImpl(`https://discord.com/api/v10/interactions/${encodeURIComponent(interaction.id)}/${encodeURIComponent(interaction.token)}/callback?with_response=true`, {
      method: 'POST',
      headers: {
        'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type: CALLBACK_TYPE,
        data: {
          content,
          allowed_mentions: { parse: [] },
          ...(ephemeral ? { flags: EPHEMERAL_MESSAGE_FLAG } : {})
        }
      }),
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
    response = await Promise.race([request, deadline]);
    const status = responseStatus(response);
    if (response?.ok !== true) {
      await Promise.race([cancelBody(response), deadline]);
      return {
        outcome: status === 429 ? INTERACTION_OUTCOMES.RATE_LIMITED : status !== null && status >= 400 && status < 500 ? INTERACTION_OUTCOMES.REJECTED : INTERACTION_OUTCOMES.UNKNOWN,
        ...(status === null ? {} : { statusCode: status }),
        reason: 'Discord interaction callback request rejected'
      };
    }
    let body: unknown = null;
    try { body = await Promise.race([response.json?.() || Promise.resolve(null), deadline]); }
    catch (error) { if (timedOut) throw error; }
    const id = responseMessageId(body);
    if (!id) {
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
    return { outcome: INTERACTION_OUTCOMES.SENT, ...(status === null ? {} : { statusCode: status }), responseMessageId: id, visibility: 'available' };
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

export { responseMessageId };
