const { encodeAgentMessage, sameAddress, verifyAgentAddress, KINDS } = require('./agent-message');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  BindingError,
  DIRECT_POST_OUTCOMES,
  PROVIDERS,
  StaleGenerationError,
  discordNonce,
  splitReply,
  validateNativeId
} = require('./state');
const { fetchDiscordChannel, sendDiscordMessage } = require('./discord');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requiredString(value, name, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BindingError(`${name} must be a non-empty string`);
  }
  return value;
}

function generationValue(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new BindingError('generation must be a positive integer');
  return generation;
}

function readTextFile(textFile) {
  const sourcePath = path.resolve(requiredString(textFile, 'text-file'));
  let stat;
  try { stat = fs.statSync(sourcePath); }
  catch (error) { throw new BindingError(`text file is unavailable: ${error.message}`); }
  if (!stat.isFile()) throw new BindingError('text file must be a regular file');
  if (stat.size > 40000) throw new BindingError('text file exceeds the 10000 character input limit');
  let text;
  try { text = fs.readFileSync(sourcePath, 'utf8'); }
  catch (error) { throw new BindingError(`text file is unreadable: ${error.message}`); }
  if (!text.length || !text.trim()) throw new BindingError('text file must contain non-empty text');
  if (text.length > 10000) throw new BindingError('text file must be at most 10000 characters');
  const parts = splitReply(text);
  if (parts.some(part => !part.trim())) throw new BindingError('text file would produce a blank Discord message; remove excess whitespace');
  if (parts.some(part => part.length > 2000)) throw new BindingError('direct post part exceeds Discord 2000 character limit');
  return { sourcePath, text, textHash: hash(text), parts };
}

function bindingMatchesRequest(binding, { nativeId, generation, channelId, provider, ordinary = false }) {
  const authorityMatches = ordinary
    ? !binding.conductorId && !binding.repoKey
    : Boolean(binding.conductorId && binding.repoKey);
  return binding.active && authorityMatches && binding.nativeId === nativeId &&
    binding.generation === generation && (!channelId || binding.channelId === channelId) && (!provider || binding.provider === provider);
}

function resolveDirectBinding(state, { nativeId, generation, channelId = null, provider = null, ordinary = false }) {
  validateNativeId(nativeId);
  if (ordinary && provider && !Object.values(PROVIDERS).includes(provider)) throw new BindingError(`ordinary post does not support provider: ${provider}`);
  const config = state.requireConfig();
  const candidates = state.listBindings().filter(binding => binding.guildId === config.guildId &&
    bindingMatchesRequest(binding, { nativeId, generation, channelId, provider, ordinary }) &&
    (!ordinary || state.isOrdinaryBinding(binding)));
  if (candidates.length === 0) throw new StaleGenerationError(`no active ${ordinary ? `ordinary ${provider || 'native'}` : 'conductor'} binding matches the requested native owner`);
  if (candidates.length !== 1) throw new BindingError(`${ordinary ? 'ordinary post' : 'direct post'} requires --channel-id when the native owner is ambiguous`);
  return candidates[0];
}

function resolveDedupeKey({ dedupeKey, requestId } = {}, { required = false } = {}) {
  const canonical = dedupeKey === undefined ? undefined : requiredString(dedupeKey, 'dedupe-key', 256);
  const legacy = requestId === undefined ? undefined : requiredString(requestId, 'request-id', 256);
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new BindingError('dedupe-key and request-id must match');
  }
  const resolved = canonical ?? legacy;
  if (required && resolved === undefined) throw new BindingError('dedupe-key or request-id is required');
  return resolved;
}

function inReplyToValue(value) {
  if (value === undefined || value === null) return null;
  return requiredString(value, 'in-reply-to', 128);
}

function requestIdFor(binding, _operatorId, sourcePath, textHash, explicitRequestId, inReplyTo = null) {
  if (explicitRequestId !== undefined) return requiredString(explicitRequestId, 'request-id', 256);
  const identity = ['direct-post-v1', binding.channelId, binding.guildId, binding.provider, binding.nativeId, binding.generation,
    binding.conductorId, binding.repoKey, sourcePath, textHash];
  if (inReplyTo !== null) return hash(['direct-post-v2', ...identity, inReplyTo]);
  return hash(identity);
}

const ADDRESS_KEYS = Object.freeze(['guildId', 'channelId', 'provider', 'nativeId', 'generation']);

function canonicalAddress(address) {
  return Object.fromEntries(ADDRESS_KEYS.map(key => [key, address[key]]));
}

async function verifyAgentDestination({ token, agentTarget, fetchImpl, signal, timeoutMs }) {
  const channel = await fetchDiscordChannel({ token, channelId: agentTarget.channelId, fetchImpl, signal, timeoutMs });
  if (channel.id !== agentTarget.channelId || channel.guild_id !== agentTarget.guildId) {
    throw Object.assign(new BindingError('agent target channel does not match its declared guild'), { outcome: 'not_sent' });
  }
}

function resolveAgentReplyRequest(state, replyTo, source, target) {
  const matches = state.listReceipts()
    .filter(row => row.kind === 'agent-message')
    .map(row => {
      try { return JSON.parse(row.detail)?.packet || null; }
      catch { return null; }
    })
    .filter(packet => packet?.id === replyTo && packet.kind === KINDS.REQUEST &&
      sameAddress(packet.source, target) && sameAddress(packet.target, source));
  if (matches.length !== 1) throw new BindingError('agent reply target is unknown or does not match the active request');
  return matches[0];
}

function agentNonceScope(source, destination, requestId, partIndex) {
  return hash(['agent-post-v1', canonicalAddress(source), canonicalAddress(destination), requestId, partIndex]);
}

function partMeta(binding, operatorId, requestId, inReplyTo, sourcePath, textHash, parts, partIndex, agentTarget = null) {
  const nonceScope = agentTarget === null
    ? `direct:${requestId}:${partIndex}`
    : agentNonceScope(binding, agentTarget, requestId, partIndex);
  return {
    requestId,
    inReplyTo,
    attemptId: crypto.randomUUID(),
    sourcePath,
    textHash,
    operatorId,
    partHash: hash(parts[partIndex]),
    channelId: binding.channelId,
    guildId: binding.guildId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation,
    conductorId: binding.conductorId,
    repoKey: binding.repoKey,
    partIndex,
    partCount: parts.length,
    nonce: discordNonce(nonceScope),
    binding
  };
}

function outcomeFor(error) {
  return DIRECT_POST_OUTCOMES.includes(error?.outcome) ? error.outcome : 'unknown';
}

async function runDirectPost({ state, token, nativeId, generation, channelId = null, provider = null, textFile,
  dedupeKey, requestId: legacyRequestId, inReplyTo = null, signal, fetchImpl, timeoutMs, ordinary = false, agentTarget = null, agentKind = KINDS.REQUEST, agentReplyTo = null }) {
  const binding = resolveDirectBinding(state, { nativeId, generation: generationValue(generation), channelId, provider, ordinary });
  const operatorId = state.requireConfig().operatorId;
  let source = readTextFile(textFile);
  const replyTarget = inReplyToValue(inReplyTo);
  const explicitRequestId = resolveDedupeKey({ dedupeKey, requestId: legacyRequestId }, { required: agentTarget !== null });
  if (agentTarget !== null) {
    if (replyTarget !== null) throw new BindingError('agent messages use agent reply correlation, not Discord reply targets');
    const address = canonicalAddress(binding);
    agentTarget = verifyAgentAddress(agentTarget, token);
    if (agentKind === KINDS.RESULT) {
      const replyTo = requiredString(agentReplyTo, 'agent-reply-to', 128);
      resolveAgentReplyRequest(state, replyTo, address, agentTarget);
      agentReplyTo = replyTo;
    }
    const packet = { id: explicitRequestId, kind: agentKind, source: address, target: agentTarget, replyTo: agentReplyTo, text: source.text };
    const wire = encodeAgentMessage(packet, token);
    source = { ...source, textHash: hash(JSON.stringify(packet)), parts: [wire] };
  }
  const requestId = requestIdFor(binding, operatorId, source.sourcePath, source.textHash, explicitRequestId, replyTarget);
  state.recoverDirectPostReceipts();
  const parts = [];
  let claimedAny = false;
  let recorded = false;
  for (let partIndex = 0; partIndex < source.parts.length; partIndex += 1) {
    if (signal?.aborted) {
      parts.push({ index: partIndex, status: 'not_sent', messageId: null });
      break;
    }
    const meta = partMeta(binding, operatorId, requestId, replyTarget, source.sourcePath, source.textHash, source.parts, partIndex, agentTarget);
    if (agentTarget !== null) meta.deliveryChannelId = agentTarget.channelId;
    if (agentTarget !== null) {
      let existing;
      try { existing = state.inspectDirectPostPart(meta); }
      catch (error) {
        if (!(error instanceof StaleGenerationError)) throw error;
        parts.push({ index: partIndex, status: 'stale', messageId: null });
        break;
      }
      if (existing) {
        parts.push({ index: partIndex, status: existing.status, messageId: existing.outcome?.messageId || null });
        if (existing.status !== 'sent') break;
        continue;
      }
      try {
        await verifyAgentDestination({ token, agentTarget, fetchImpl, signal, timeoutMs });
      } catch (error) {
        const preflight = state.recordDirectPostPreflight(meta, outcomeFor(error), {
          status: error.status || null, error: String(error.message || error).slice(0, 300)
        });
        parts.push({ index: partIndex, status: preflight.outcome, messageId: null });
        break;
      }
      if (!state.directPostBindingCurrent(binding, operatorId)) {
        const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed during destination lookup' });
        parts.push({ index: partIndex, status: stale.outcome, messageId: null });
        break;
      }
      if (signal?.aborted) {
        const stopped = state.recordDirectPostPreflight(meta, 'not_sent', { reason: 'direct post stopped before custody' });
        parts.push({ index: partIndex, status: stopped.outcome, messageId: null });
        break;
      }
    }
    let claim;
    try { claim = state.beginDirectPostPart(meta); }
    catch (error) {
      if (!(error instanceof StaleGenerationError)) throw error;
      if (agentTarget !== null) {
        const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed before custody' });
        parts.push({ index: partIndex, status: stale.outcome, messageId: null });
      } else {
        parts.push({ index: partIndex, status: 'stale', messageId: null });
      }
      break;
    }
    if (!claim.claimed) {
      parts.push({ index: partIndex, status: claim.status, messageId: claim.outcome?.messageId || null });
      if (claim.status !== 'sent') break;
      continue;
    }
    claimedAny = true;
    if (!state.directPostBindingCurrent(binding, operatorId)) {
      const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before network' });
      parts.push({ index: partIndex, status: stale.outcome });
      break;
    }
    try {
      if (!state.directPostBindingCurrent(binding, operatorId)) {
        const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before send' });
        parts.push({ index: partIndex, status: stale.outcome });
        break;
      }
      const sent = await sendDiscordMessage({ token, channelId: agentTarget?.channelId || binding.channelId, content: source.parts[partIndex], nonce: claim.nonce,
        messageReference: replyTarget === null ? null : { message_id: replyTarget, channel_id: binding.channelId, fail_if_not_exists: true },
        signal, fetchImpl, timeoutMs });
      const outcome = state.recordDirectPostOutcome(requestId, claim.attemptId, 'sent', { messageId: String(sent.id), status: 200 });
      parts.push({ index: partIndex, status: outcome.outcome, messageId: outcome.messageId });
      recorded = true;
    } catch (error) {
      const outcome = outcomeFor(error);
      const recorded = state.recordDirectPostOutcome(requestId, claim.attemptId, outcome, { status: error.status || null, error: String(error.message || error).slice(0, 300) });
      parts.push({ index: partIndex, status: recorded.outcome, messageId: recorded.messageId || null });
      break;
    }
  }
  const status = parts.every(part => part.status === 'sent') ? 'sent' : parts.find(part => part.status !== 'sent')?.status || 'not_sent';
  const duplicate = !claimedAny && parts.length > 0 && parts.every(part => part.status === 'sent');
  return { requestId, dedupeKey: requestId, inReplyTo: replyTarget, channelId: agentTarget?.channelId || binding.channelId, provider: binding.provider,
    nativeId: binding.nativeId, generation: binding.generation, status, state: status, recorded, duplicate,
    messageIds: parts.filter(part => part.messageId).map(part => part.messageId), parts };
}

module.exports = { readTextFile, resolveDedupeKey, resolveDirectBinding, requestIdFor, runDirectPost };
