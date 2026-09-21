const { PROVIDERS, READINESS, RECOVERY_LIMITS, validateNativeId } = require('../state');
const { requireInstalled } = require('../discord');
const { conductorMarkerMatches: matchesTopicMarker, parseLegacyConductorMarker, staticConductorMarker, topicPresentation } = require('../topic');

function provisionMarker(provider, nativeId) {
  return `discord-surface:v1 provider=${provider} native=${nativeId}`;
}

function conductorMarker({ provider, nativeId, conductorId, repoKey, generation = 1, readiness = READINESS.PENDING }) {
  if (!conductorId || !repoKey) return provisionMarker(provider, nativeId);
  return staticConductorMarker({ provider, conductorId, repoKey });
}

function legacyAdoptionTopic(topic, provider, nativeId) {
  const base = topicPresentation(topic).base;
  return base === provisionMarker(provider, nativeId) || base === `Conductor task: ${provider}/${nativeId}`;
}

function conductorMarkerMatches(topic, expected) {
  return matchesTopicMarker(topic, expected);
}

function validateLegacyMetadata(topic, expected) {
  const parsed = parseLegacyConductorMarker(topic);
  if (parsed) {
    const matches = conductorMarkerMatches(topic, {
      provider: expected.provider,
      nativeId: expected.nativeId,
      conductorId: expected.conductorId,
      repoKey: expected.repoKey,
      generation: parsed.generation
    });
    if (!matches || (expected.generation != null && parsed.generation !== expected.generation)) {
      throw new Error('legacy channel topic does not match the requested provider, conductor, repository, native UUID, or generation');
    }
    return parsed;
  }
  if (legacyAdoptionTopic(topic, expected.provider, expected.nativeId)) {
    return { version: 'v1', provider: expected.provider, nativeId: expected.nativeId, conductorId: expected.conductorId, repoKey: expected.repoKey, generation: null };
  }
  throw new Error('channel topic is not a recognized legacy marker');
}

function legacyMarkerMatches(topic, expected) {
  const parsed = parseLegacyConductorMarker(topic);
  if (parsed) {
    return conductorMarkerMatches(topic, {
      provider: expected.provider,
      nativeId: expected.nativeId,
      conductorId: expected.conductorId,
      repoKey: expected.repoKey,
      generation: parsed.generation
    });
  }
  return legacyAdoptionTopic(topic, expected.provider, expected.nativeId);
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {}
}

function topicPatchOutcome(error) {
  if (error?.status === 429 || error?.code === 429) return 'rate_limited';
  if ([400, 401, 403, 404].includes(error?.status) || error?.code === 50013) return 'rejected';
  return 'unknown';
}

async function patchDiscordTopic({ token, channelId, topic, signal }) {
  if (typeof globalThis.fetch !== 'function') throw new Error('Discord topic migration fetch is unavailable');
  const response = await globalThis.fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ topic }),
    signal
  });
  if (!response.ok) {
    await cancelResponseBody(response);
    const error = new Error('Discord legacy topic migration was rejected');
    error.status = response.status;
    throw error;
  }
  try { return await response.json(); }
  catch (error) {
    await cancelResponseBody(response);
    throw error;
  }
}

async function migrateLegacyTopic({ state, channel, binding, token, request = patchDiscordTopic, timeoutMs = RECOVERY_LIMITS.timeoutMs }) {
  const desiredTopic = staticConductorMarker({ provider: binding.provider, conductorId: binding.conductorId, repoKey: binding.repoKey });
  if (channel.topic === desiredTopic) return { migrated: false, topic: desiredTopic, binding };
  const custody = state.beginTopicPublication(channel.id, {
    desiredReadiness: binding.readiness,
    desiredTopic
  }, binding);
  if (!custody) throw new Error('legacy topic migration binding changed before custody started');
  const controller = new AbortController();
  const boundedMs = Math.max(1, Number(timeoutMs || RECOVERY_LIMITS.timeoutMs));
  let timer;
  let settled = false;
  try {
    const operation = Promise.resolve().then(() => request({ token, channelId: channel.id, topic: desiredTopic, signal: controller.signal }));
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('Discord legacy topic migration deadline exceeded');
        error.publicationUnknown = true;
        reject(error);
      }, boundedMs);
    });
    const response = await Promise.race([operation, deadline]);
    if (!response || response.topic !== desiredTopic) {
      const error = new Error('Discord legacy topic migration response did not confirm the static marker');
      error.publicationUnknown = true;
      throw error;
    }
    const recorded = state.recordTopicPublication(channel.id, {
      requestId: custody.requestId,
      desiredReadiness: binding.readiness,
      outcome: 'published',
      publishedReadiness: binding.readiness,
      observedTopic: response.topic,
      remoteTerminal: true
    }, binding);
    settled = true;
    channel.topic = response.topic;
    return { migrated: true, topic: response.topic, custody: recorded, binding };
  } catch (error) {
    const outcome = topicPatchOutcome(error);
    if (!settled) {
      state.recordTopicPublication(channel.id, {
        requestId: custody.requestId,
        desiredReadiness: binding.readiness,
        outcome,
        publicationUnknown: outcome === 'unknown',
        observedTopic: channel.topic,
        error: error.message,
        remoteTerminal: outcome !== 'unknown'
      }, binding);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function ensureProvisionedChannel({ guild, provider, nativeId, categoryId, taskName, conductorId, repoKey, generation = 1, readiness = READINESS.PENDING, channelId = null, allowCreate = true, allowLegacy = false }) {
  if (provider !== PROVIDERS.CODEX && provider !== PROVIDERS.CLAUDE) throw new Error('unsupported provider');
  validateNativeId(nativeId);
  if (typeof conductorId !== 'string' || !conductorId || typeof repoKey !== 'string' || !repoKey) throw new Error('conductor identity is required for channel provisioning');
  if (typeof categoryId !== 'string' || !categoryId) throw new Error('categoryId is required');
  const marker = conductorMarker({ provider, nativeId, conductorId, repoKey, generation, readiness });
  if (typeof guild.channels?.fetch === 'function') await guild.channels.fetch();
  const channels = guild.channels?.cache ? [...guild.channels.cache.values()] : [];
  let adopted = false;
  let marked;
  if (channelId) {
    const channel = typeof guild.channels.fetch === 'function' ? await guild.channels.fetch(channelId) : channels.find(item => item.id === channelId);
    if (!channel) throw new Error('requested adoption channel was not found');
    if (channel.parentId !== categoryId) throw new Error('requested adoption channel is outside the configured vendor category');
    if (channel.topic !== marker) {
      const legacy = parseLegacyConductorMarker(channel.topic);
      const v2Match = legacy && conductorMarkerMatches(channel.topic, { provider, nativeId, conductorId, repoKey, generation: legacy.generation });
      const legacyMatch = legacyAdoptionTopic(channel.topic, provider, nativeId);
      if (!v2Match && !legacyMatch) throw new Error('requested adoption channel metadata does not match the native identity');
      if (!allowLegacy) throw new Error('legacy channel topic requires explicit --migrate-legacy-topic --channel-id');
      adopted = legacyMatch;
      return { channel, created: false, adopted, legacy: true, legacyMetadata: legacy || { version: 'v1', provider, nativeId, generation: null }, marker: channel.topic };
    }
    return { channel, created: false, adopted, marker };
  }
  marked = channels.filter(channel => channel.topic === marker);
  if (marked.length > 1) throw new Error('duplicate provision markers require reconciliation');
  const existingMarker = marked[0];
  if (existingMarker && existingMarker.parentId !== categoryId) throw new Error('provision marker exists under the wrong category');
  const existing = existingMarker;
  const legacyMarkers = channels.filter(channel => legacyMarkerMatches(channel.topic, { provider, nativeId, conductorId, repoKey }));
  if (legacyMarkers.length > 1) throw new Error('duplicate legacy provision markers require explicit reconciliation');
  if (legacyMarkers[0] && legacyMarkers[0].parentId !== categoryId) throw new Error('legacy provision marker exists under the wrong category');
  if (existing) throw new Error('existing static conductor marker requires explicit --channel-id adoption');
  if (legacyMarkers[0]) throw new Error('existing legacy conductor marker requires explicit --channel-id adoption');
  if (!allowCreate) throw new Error('provision intent is unresolved and has no reconciled Discord channel; use explicit --channel-id adoption before retrying');
  const type = requireInstalled('discord.js').ChannelType.GuildText;
  const presentationName = typeof taskName === 'string' && taskName ? taskName : `${provider}-${nativeId.slice(0, 8)}`;
  const channel = await guild.channels.create({
    name: presentationName.slice(0, 100),
    type,
    parent: categoryId,
    topic: marker,
    reason: 'Create an explicitly bound native Discord surface'
  });
  return { channel, created: true, adopted: false, marker };
}

module.exports = { provisionMarker, conductorMarker, legacyAdoptionTopic, validateLegacyMetadata, migrateLegacyTopic, ensureProvisionedChannel };
