import { resolveExistingChannel, type ExistingDiscordChannel } from '../ordinary-codex';

export interface DiscordChannelLike {
  id: string;
  guildId?: string | null;
  name?: string | null;
  isTextBased?: () => boolean;
}

interface DiscordChannelCollectionLike {
  values: () => IterableIterator<DiscordChannelLike>;
}

export interface DiscordGuildLike {
  channels: {
    fetch: (channelId?: string) => Promise<
      DiscordChannelLike | null | DiscordChannelLike[] | DiscordChannelCollectionLike
    >;
  };
}

function hasValues(value: unknown): value is DiscordChannelCollectionLike {
  return typeof (value as { values?: unknown } | null | undefined)?.values === 'function';
}

function isDiscordChannelLike(value: unknown): value is DiscordChannelLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !hasValues(value)
    && typeof (value as { id?: unknown }).id === 'string';
}

export async function resolveDiscordChannel(
  guild: DiscordGuildLike,
  selection: string,
  configuredGuildId: unknown
) {
  const mentionId = selection.match(/^<#([^>]+)>$/)?.[1] || (/^\d+$/.test(selection) ? selection : null);
  let fetchedChannels: ExistingDiscordChannel[];
  let fetchedChannelObjects: DiscordChannelLike[];
  if (mentionId) {
    const fetched = await guild.channels.fetch(mentionId);
    const channel = isDiscordChannelLike(fetched) ? fetched : null;
    fetchedChannelObjects = channel ? [channel] : [];
    fetchedChannels = channel ? [{ id: channel.id, guildId: channel.guildId || '', name: channel.name || null,
      messageCapable: typeof channel.isTextBased === 'function' && channel.isTextBased() }] : [];
  } else {
    const fetched = await guild.channels.fetch();
    const values: DiscordChannelLike[] = Array.isArray(fetched) ? fetched as DiscordChannelLike[] : hasValues(fetched) ? [...fetched.values()] : [];
    fetchedChannelObjects = values;
    fetchedChannels = values.map(channel => ({ id: channel.id, guildId: channel.guildId || '', name: channel.name || null,
      messageCapable: typeof channel.isTextBased === 'function' && channel.isTextBased() }));
  }
  const channel = resolveExistingChannel(selection, configuredGuildId, fetchedChannels);
  const discordChannel = fetchedChannelObjects.find(candidate => candidate?.id === channel.id);
  return { channel, discordChannel, fetchedChannels };
}

export function assertSameChannelSelection(
  channel: ExistingDiscordChannel,
  alternateSelection: unknown,
  configuredGuildId: unknown,
  fetchedChannels: readonly ExistingDiscordChannel[]
): void {
  if (!alternateSelection) return;
  const alternate = resolveExistingChannel(alternateSelection, configuredGuildId, fetchedChannels);
  if (channel.id !== alternate.id) throw new Error('--channel and --channel-id must identify the same channel');
}
