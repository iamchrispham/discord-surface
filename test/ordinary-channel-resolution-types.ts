import {
  assertSameChannelSelection,
  resolveDiscordChannel,
  type DiscordGuildLike
} from '../src/ordinary-bind/channel-resolution';
import type { ExistingDiscordChannel } from '../src/ordinary-codex';

const discordChannel = {
  id: '123',
  guildId: 'guild',
  name: 'ops',
  isTextBased: () => true
};

const guild: DiscordGuildLike = {
  channels: {
    fetch: async channelId => channelId ? discordChannel : [discordChannel]
  }
};

async function typecheckChannelResolution(): Promise<ExistingDiscordChannel> {
  const resolved = await resolveDiscordChannel(guild, '<#123>', 'guild');
  const channel: ExistingDiscordChannel = resolved.channel;
  assertSameChannelSelection(channel, '123', 'guild', resolved.fetchedChannels);
  return channel;
}

void typecheckChannelResolution;
