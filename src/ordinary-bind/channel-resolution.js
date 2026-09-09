const { resolveExistingChannel } = require('../ordinary-codex');

async function resolveDiscordChannel(guild, selection, configuredGuildId) {
  const mentionId = selection.match(/^<#([^>]+)>$/)?.[1] || (/^\d+$/.test(selection) ? selection : null);
  let fetchedChannels;
  let fetchedChannelObjects;
  if (mentionId) {
    const channel = await guild.channels.fetch(mentionId);
    fetchedChannelObjects = channel ? [channel] : [];
    fetchedChannels = channel ? [{ id: channel.id, guildId: channel.guildId || '', name: channel.name || null,
      messageCapable: typeof channel.isTextBased === 'function' && channel.isTextBased() }] : [];
  } else {
    const fetched = await guild.channels.fetch();
    const values = Array.isArray(fetched) ? fetched : typeof fetched?.values === 'function' ? [...fetched.values()] : [];
    fetchedChannelObjects = values;
    fetchedChannels = values.map(channel => ({ id: channel.id, guildId: channel.guildId || '', name: channel.name || null,
      messageCapable: typeof channel.isTextBased === 'function' && channel.isTextBased() }));
  }
  const channel = resolveExistingChannel(selection, configuredGuildId, fetchedChannels);
  const discordChannel = fetchedChannelObjects.find(candidate => candidate?.id === channel.id);
  return { channel, discordChannel, fetchedChannels };
}

function assertSameChannelSelection(channel, alternateSelection, configuredGuildId, fetchedChannels) {
  if (!alternateSelection) return;
  const alternate = resolveExistingChannel(alternateSelection, configuredGuildId, fetchedChannels);
  if (channel.id !== alternate.id) throw new Error('--channel and --channel-id must identify the same channel');
}

module.exports = { assertSameChannelSelection, resolveDiscordChannel };
