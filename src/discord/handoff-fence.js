const { RECOVERY_LIMITS } = require('../state');

function compareDiscordIds(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function historyMessages(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (typeof result.values === 'function') return [...result.values()];
  if (typeof result[Symbol.iterator] === 'function') return [...result];
  return [];
}

async function createHandoffFence(channel, operation = 'ordinary handoff') {
  if (typeof channel?.send !== 'function') throw new Error(`${operation} requires a Discord server fence`);
  const message = await channel.send({
    content: '\u200b',
    allowedMentions: { parse: [] }
  });
  if (typeof message?.id !== 'string' || message.id.length === 0) {
    throw new Error('Discord handoff fence has no stable ID');
  }
  return message;
}

async function deleteHandoffFence(message) {
  if (typeof message?.delete !== 'function') return;
  try { await message.delete(); } catch {}
}

function serverDerivedChannelCutoff(channel) {
  return typeof channel?.id === 'string' && /^\d+$/.test(channel.id) ? channel.id : null;
}

async function assertOrdinaryIntakeRange(channel, state, binding, recoveredThrough, fenceId, operation) {
  if (!recoveredThrough) throw new Error(`${operation} requires a confirmed Discord intake boundary`);
  if (typeof channel?.messages?.fetch !== 'function') throw new Error(`${operation} requires Discord history range access`);
  let after = recoveredThrough;
  let pages = 0;
  let total = 0;
  while (pages < RECOVERY_LIMITS.maxPages && total < RECOVERY_LIMITS.maxMessages) {
    const page = historyMessages(await channel.messages.fetch({
      limit: RECOVERY_LIMITS.pageSize,
      after
    }));
    pages += 1;
    if (!page.length) {
      if (after !== recoveredThrough && !state.checkpointIntake(binding.channelId, after, binding)) throw new Error(`${operation} source binding changed`);
      return;
    }
    if (page.some(message => typeof message?.id !== 'string' || message.id.length === 0)) {
      throw new Error(`${operation} encountered a Discord message without a stable ID`);
    }
    page.sort((left, right) => compareDiscordIds(left.id, right.id));
    const reachedFence = page.some(message => compareDiscordIds(message.id, fenceId) >= 0);
    const fresh = page.filter(message => compareDiscordIds(message.id, after) > 0 && compareDiscordIds(message.id, fenceId) < 0);
    if (!fresh.length) {
      if (reachedFence || page.length < RECOVERY_LIMITS.pageSize) {
        if (after !== recoveredThrough && !state.checkpointIntake(binding.channelId, after, binding)) throw new Error(`${operation} source binding changed`);
        return;
      }
      throw new Error(`${operation} requires Discord intake to be durably drained`);
    }
    for (const message of fresh) {
      if (total >= RECOVERY_LIMITS.maxMessages || !state.hasIntakeEvidence(message.id)) {
        throw new Error(`${operation} requires Discord intake to be durably drained`);
      }
      after = message.id;
      total += 1;
    }
    if (reachedFence || page.length < RECOVERY_LIMITS.pageSize) {
      if (after !== recoveredThrough && !state.checkpointIntake(binding.channelId, after, binding)) throw new Error(`${operation} source binding changed`);
      return;
    }
  }
  throw new Error(`${operation} requires Discord intake to be durably drained`);
}

module.exports = {
  assertOrdinaryIntakeRange,
  createHandoffFence,
  deleteHandoffFence,
  serverDerivedChannelCutoff
};
