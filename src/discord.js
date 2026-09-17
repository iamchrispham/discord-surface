const { PREFIX: AGENT_PREFIX } = require('./agent-message');
const { WATCHER_NOTICE_PREFIX } = require('./watcher-notice');
const path = require('node:path');
const {
  AGENT_ATTACHMENT_CONTENT_TYPE,
  AGENT_ATTACHMENT_FILENAME,
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_ATTACHMENT_RECOVERY_KINDS,
  fetchAgentAttachment,
  normalizeAgentMessage
} = require('./agent-attachment');
const fs = require('node:fs');
const { ACK_WAITING, REACTION, acknowledgmentCommand, createAcknowledgmentDelivery, waitForAcknowledgment, watchAcknowledgments } = require('./acknowledgment');
const { CODEX_VALIDATION_KINDS, codexPrompt, dispatchAndObserve, agentCompletionCommand, watcherNoticeCompletionCommand, ClaudeProvider, CodexProvider, observeSubmitted, probeClaudeChannel, readInitialCursor, validateCodexSessionIdentity, validateCodexSessionIdentityAsync, waitForReply } = require('./native');
const { DISPATCH_OUTCOMES, MESSAGE_STATES, READINESS, RECOVERY_LIMITS, TRANSPORT_RECEIPT_OUTCOMES, UnresolvedWorkError } = require('./state');
const { COURIER_OUTCOMES, COURIER_RESULT_STATUSES, isCourierOriginAllowed } = require('./state/courier-route');
const { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX } = require('./ordinary/constants');
const { conductorMarkerMatches } = require('./topic');
const { DIRECT_POST_FILE_LIMITS, readDirectPostFileSnapshot } = require('./direct-post-file');
const { assertPublicThread, historyPermission, recoverThread } = require('./discord/thread-enrollment');
const { isPreAdoptionRetryableThread, isRetryableFetchBoundary, recoveryFetch } = require('./discord/recovery-fetch');
const { THREAD_STATES } = require('./state/thread-enrollment');
const { parseComponentInteraction, parseCsInteraction, sendInteractionCallback, upsertGuildCsCommand } = require('./discord-interaction');
const { createDecisionConsumer } = require('./discord/decision');

const requireInstalled = require;
const DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS = 100;
const DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS = 5000;
const LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS = 1000;
const LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS = 30_000;
const PENDING_HANDOFF_RECOVERY_POLL_MS = 100;
const INTERACTION_CALLBACK_TIMEOUT_MS = 2500;
const INTERACTION_REJECTION_MESSAGES = Object.freeze({
  'inactive-binding': 'This channel is not connected to an active status session.',
  'binding-not-ready': 'The status session is still recovering. Try again shortly.',
  'handoff-intake-paused': 'Status intake is paused during handoff. Try again shortly.',
  'unauthorized-interaction': 'You are not authorized to use /cs.',
  'unknown-binding': 'This channel is not connected to a status session.',
  'stale-binding': 'The status session changed before /cs was accepted. Try again shortly.'
});

function recoveryError(kind, detail) {
  const error = new Error(detail);
  error.recoveryKind = kind;
  return error;
}

function waitForRecoveryOperation(operation, signal, deadline, onDeadline = null) {
  if (signal?.aborted) return Promise.reject(recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord recovery was stopped'));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Discord recovery deadline exceeded'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord recovery was stopped'));
    timer = setTimeout(() => {
      try { onDeadline?.(); } finally { finish(reject, recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Discord recovery deadline exceeded')); }
    }, remaining);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(operation).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

function recoveryKind(error) {
  return error?.recoveryKind || null;
}

function interactionRejectionMessage(reason) {
  return INTERACTION_REJECTION_MESSAGES[reason] || 'The status command is temporarily unavailable. Try again shortly.';
}

function compareDiscordIds(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
}

function isDiscordId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function sameNativeOwner(left, right) {
  return left.provider === right.provider && left.nativeId === right.nativeId;
}

function compareRecoveryCandidates(left, right) {
  if (sameNativeOwner(left, right) && isDiscordId(left.id) && isDiscordId(right.id)) {
    const byDiscordId = compareDiscordIds(left.id, right.id);
    if (byDiscordId !== 0) return byDiscordId;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

function discordIdAfter(left, right) {
  if (!left || !right) return false;
  return compareDiscordIds(left, right) > 0;
}

function conductorMarkerMatchesTopic(topic, binding) {
  if (!binding.conductorId && !binding.repoKey) return true;
  if (!binding.conductorId || !binding.repoKey || typeof topic !== 'string') return false;
  return conductorMarkerMatches(topic, binding);
}

function bindingIdentityMatches(expected, current) {
  return Boolean(current?.active) && current.channelId === expected.channelId && current.guildId === expected.guildId &&
    current.provider === expected.provider && current.nativeId === expected.nativeId &&
    current.generation === expected.generation && current.conductorId === expected.conductorId && current.repoKey === expected.repoKey;
}

function readSecret(secretFile) {
  if (!fs.existsSync(secretFile)) throw new Error('Discord secret file does not exist');
  const mode = fs.statSync(secretFile).mode & 0o777;
  if (mode & 0o077) throw new Error('Discord secret file must be owner-only');
  const lines = fs.readFileSync(secretFile, 'utf8').split(/\r?\n/);
  const assignment = lines.find(line => /^\s*DISCORD_TOKEN\s*=/.test(line));
  const match = assignment?.match(/^\s*DISCORD_TOKEN\s*=\s*(.*?)\s*$/);
  if (!match) throw new Error('Discord secret file must contain a DISCORD_TOKEN assignment');
  let token = match[1];
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) token = token.slice(1, -1);
  if (!token) throw new Error('Discord secret file contains an empty DISCORD_TOKEN');
  return token;
}

function eventToInput(message) {
  let attachments = message.attachments;
  if (attachments === undefined || attachments === null) attachments = [];
  else if (!Array.isArray(attachments) && typeof attachments.values === 'function') {
    try { attachments = [...attachments.values()]; } catch {}
  }
  if (Array.isArray(attachments)) {
    attachments = attachments.map(attachment => attachment && typeof attachment === 'object' ? {
      url: attachment.url,
      filename: attachment.filename ?? attachment.name,
      contentType: attachment.contentType ?? null,
      size: attachment.size
    } : attachment);
  }
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author?.id,
    isBot: Boolean(message.author?.bot),
    content: message.content,
    attachments,
    nonce: message.nonce == null ? null : String(message.nonce)
  };
}

function classifyReplyError(error) {
  if (error?.outcome) return error.outcome;
  if (/authorization|stale|custody|generation/i.test(error?.message || '')) return 'failed';
  if ([400, 401, 403, 404, 413].includes(error?.status) || error?.code === 50013) return 'failed';
  if (error?.status >= 500 || error?.potentiallyDelivered || error?.wrote || error?.name === 'TypeError') return 'unknown';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)) return 'unknown';
  return 'unknown';
}

function classifyTransportReceiptError(error) {
  if (error?.outcome === 'not_sent') return 'not_sent';
  if (error?.outcome !== 'sent' && TRANSPORT_RECEIPT_OUTCOMES.includes(error?.outcome)) return error.outcome;
  if (error?.status === 429 || error?.code === 429 || /^RateLimitError(?:\[|$)/.test(String(error?.name || '')) || /^RateLimitError(?:\[|$)/.test(String(error?.message || ''))) return 'rate_limited';
  if ([400, 401, 403, 404].includes(error?.status) || error?.code === 50013) return 'rejected';
  return 'unknown';
}

function cancelResponseBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}

async function readRetryAfter(response) {
  const headerValue = typeof response?.headers?.get === 'function'
    ? response.headers.get('retry-after') ?? response.headers.get('Retry-After')
    : response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'];
  const hasHeaderValue = headerValue !== null && headerValue !== undefined && String(headerValue).trim() !== '';
  const headerSeconds = hasHeaderValue ? Number(headerValue) : NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return { raw: headerValue, milliseconds: Math.ceil(headerSeconds * 1000) };
  }
  try {
    const body = await response?.json?.();
    const bodySeconds = Number(body?.retry_after);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0) {
      return { raw: body.retry_after, milliseconds: Math.ceil(bodySeconds * 1000) };
    }
  } catch {}
  return null;
}

async function sendDiscordMessage({ token, channelId, content, nonce, signal, timeoutMs = RECOVERY_LIMITS.timeoutMs,
  fetchImpl = globalThis.fetch, messageReference = null, allowedMentions = { parse: [] }, agentAttachment = null, fileAttachment = null, components = null }) {
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('Discord message fetch is unavailable'), { outcome: 'not_sent' });
  if (signal?.aborted) throw Object.assign(new Error('Discord message send stopped before request'), { outcome: 'not_sent' });
  if (agentAttachment !== null && (!Buffer.isBuffer(agentAttachment) || agentAttachment.length === 0 || agentAttachment.length > AGENT_ATTACHMENT_MAX_BYTES)) {
    throw Object.assign(new Error('agent attachment is outside the bounded wire limit'), { outcome: 'not_sent' });
  }
  if (agentAttachment !== null && fileAttachment !== null) throw Object.assign(new Error('Discord message cannot carry both attachment kinds'), { outcome: 'not_sent' });
  if (fileAttachment !== null && (!fileAttachment || !Buffer.isBuffer(fileAttachment.bytes) || fileAttachment.bytes.length > DIRECT_POST_FILE_LIMITS.maxBytes ||
      typeof fileAttachment.filename !== 'string' || !fileAttachment.filename || path.basename(fileAttachment.filename) !== fileAttachment.filename || fileAttachment.filename.length > 255)) {
    throw Object.assign(new Error('file attachment is outside the bounded wire limit'), { outcome: 'not_sent' });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  let started = false;
  const operation = (async () => {
    started = true;
    let response;
    try {
      const payload = {
        content, nonce, enforce_nonce: true, allowed_mentions: allowedMentions,
        ...(messageReference ? { message_reference: messageReference } : {}),
        ...(components ? { components } : {})
      };
      const request = {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'DiscordBot (discord-surface, 0.1.0)'
        },
        signal: controller.signal
      };
      if (agentAttachment === null && fileAttachment === null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = JSON.stringify(payload);
      } else {
        if (typeof FormData !== 'function' || typeof Blob !== 'function') {
          throw Object.assign(new Error('multipart Discord message support is unavailable'), { outcome: 'not_sent' });
        }
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        const bytes = agentAttachment === null ? fileAttachment.bytes : agentAttachment;
        const filename = agentAttachment === null ? fileAttachment.filename : AGENT_ATTACHMENT_FILENAME;
        const contentType = agentAttachment === null ? DIRECT_POST_FILE_LIMITS.contentType : AGENT_ATTACHMENT_CONTENT_TYPE;
        form.append('files[0]', new Blob([bytes], { type: contentType }), filename);
        request.body = form;
      }
      response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, request);
    } catch (error) {
      if (!error.outcome) error.outcome = started ? 'unknown' : 'not_sent';
      throw error;
    }
    if (!response?.ok) {
      await cancelResponseBody(response);
      const error = new Error('Discord direct post request rejected');
      error.status = response?.status;
      error.outcome = response?.status === 429 ? 'rate_limited' : [400, 401, 403, 404].includes(response?.status) ? 'not_sent' : 'unknown';
      throw error;
    }
    let body;
    try { body = await response.json(); }
    catch (error) { await cancelResponseBody(response); error.outcome = 'unknown'; throw error; }
    if (!body?.id) {
      await cancelResponseBody(response);
      throw Object.assign(new Error('Discord direct post response lacks message id'), { outcome: 'unknown' });
    }
    return body;
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Discord direct post deadline exceeded'), { outcome: 'unknown' }));
    }, Math.max(1, Number(timeoutMs)));
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    operation.catch(() => {});
  }
}

async function fetchDiscordChannel({ token, channelId, signal, timeoutMs = RECOVERY_LIMITS.timeoutMs, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('Discord channel fetch is unavailable'), { outcome: 'not_sent' });
  if (signal?.aborted) throw Object.assign(new Error('Discord channel lookup stopped before request'), { outcome: 'not_sent' });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'DiscordBot (discord-surface, 0.1.0)'
        },
        signal: controller.signal
      });
    } catch (error) {
      if (!error.outcome) error.outcome = 'not_sent';
      throw error;
    }
    if (!response?.ok) {
      await cancelResponseBody(response);
      const error = new Error('Discord channel lookup request rejected');
      error.status = response?.status;
      error.outcome = response?.status === 429 ? 'rate_limited' : 'not_sent';
      throw error;
    }
    let body;
    try { body = await response.json(); }
    catch (error) { await cancelResponseBody(response); error.outcome = 'not_sent'; throw error; }
    if (typeof body?.id !== 'string' || typeof body?.guild_id !== 'string') {
      throw Object.assign(new Error('Discord channel response lacks destination identity'), { outcome: 'not_sent' });
    }
    return body;
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Discord channel lookup deadline exceeded'), { outcome: 'not_sent' }));
    }, Math.max(1, Number(timeoutMs)));
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    operation.catch(() => {});
  }
}

function transportReceiptText(message, attempt) {
  if (attempt.readiness === 'ready') return 'Receipt: saved for this conductor.';
  return 'Receipt: saved. Delivery was paused when this receipt was prepared.';
}

function createSurfaceConsumer({ state, stateDir = path.dirname(state.dbPath), providers, sendReply, sendTransportReceipt, prepareReply, trackReceipt, observeOptions = {},
  agentCredential = () => null, agentAttachmentFetch = globalThis.fetch,
  agentAttachmentTimeoutMs = RECOVERY_LIMITS.timeoutMs, agentBotId = () => null, readyForLiveIntake = null, courierRoute = null }) {
  const receiptWork = new Set();
  const nativeWork = new Map();
  const ownerQueues = new Map();
  const queuedNativeWork = new Map();
  const intakeQueues = new Map();
  const intakeBarriers = new Map();
  let queueSequence = 0;

  function attachmentIntakeFailure(error) {
    return [AGENT_ATTACHMENT_RECOVERY_KINDS.INTAKE, CODEX_VALIDATION_KINDS.DEADLINE].includes(recoveryKind(error));
  }

  function blockIntake(channelId) {
    if (intakeBarriers.has(channelId)) return;
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    intakeBarriers.set(channelId, { promise, release });
  }

  function releaseIntake(channelId) {
    const barrier = intakeBarriers.get(channelId);
    if (!barrier) return;
    intakeBarriers.delete(channelId);
    barrier.release();
  }

  async function waitForIntakeBarrier(channelId, signal) {
    const barrier = intakeBarriers.get(channelId);
    if (!barrier) return;
    if (signal?.aborted) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord intake was stopped while awaiting attachment recovery');
    await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onAbort = () => finish(reject, recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord intake was stopped while awaiting attachment recovery'));
      signal?.addEventListener('abort', onAbort, { once: true });
      barrier.promise.then(value => finish(resolve, value), error => finish(reject, error));
    });
  }

  function serializeIntake(message, operation, { signal = null, bypassBarrier = false } = {}) {
    const channelId = message?.channelId;
    if (typeof channelId !== 'string') return operation();
    if (bypassBarrier && intakeBarriers.has(channelId)) return operation();
    const previous = intakeQueues.get(channelId) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (!bypassBarrier) await waitForIntakeBarrier(channelId, signal);
      try {
        return await operation();
      } catch (error) {
        if (!bypassBarrier && attachmentIntakeFailure(error)) blockIntake(channelId);
        throw error;
      }
    });
    intakeQueues.set(channelId, current);
    current.finally(() => {
      if (intakeQueues.get(channelId) === current) intakeQueues.delete(channelId);
    }).catch(() => {});
    return current;
  }

  function rejectEnrolledChildBot(message, expectedBinding, ready, coverageId = null) {
    const route = state.getMessageRoute(message?.channelId);
    if (!route?.enrollment || !message?.author?.bot) return null;
    const content = typeof message.content === 'string' ? message.content : '';
    const input = eventToInput(message);
    if (content.startsWith(AGENT_PREFIX) || content.startsWith(WATCHER_NOTICE_PREFIX) || input.attachments?.length) return null;
    return state.acceptDiscordMessage(input, { ready, coverageId, expectedBinding });
  }

  function connectedBotId() {
    return typeof agentBotId === 'function' ? agentBotId() : agentBotId;
  }

  function trackReceiptWork(work) {
    const tracked = Promise.resolve(work).catch(() => null);
    receiptWork.add(tracked);
    tracked.finally(() => receiptWork.delete(tracked)).catch(() => {});
    trackReceipt?.(tracked);
    return tracked;
  }

  async function issueTransportReceipt(message) {
    const started = state.beginTransportReceipt(message.id);
    if (!started.started) return started;
    const authorized = state.authorizeTransportReceipt(message.id, started.binding);
    if (!authorized) return state.recordTransportReceiptOutcome(message.id, 'stale', { reason: 'authorization changed before receipt send' });
    const payload = {
      ...authorized.attempt,
      content: transportReceiptText(message, authorized.attempt),
      reaction: authorized.attempt.readiness === READINESS.READY ? REACTION.SAVED : null,
      nonce: authorized.nonce,
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
      reply: { messageReference: message.id, failIfNotExists: false }
    };
    const sender = sendTransportReceipt || (async (source, receipt) => {
      if (!receipt.reaction) return source.channel?.send(receipt);
      let target = source;
      if (typeof target.react !== 'function') {
        target = await source.channel?.messages?.fetch?.(source.id);
      }
      if (typeof target?.react !== 'function') {
        throw new Error('Discord source message does not support reactions');
      }
      await target.react(receipt.reaction);
      return { messageId: source.id };
    });
    try {
      const sent = await sender(message, payload);
      const receiptMessageId = sent?.id || sent?.messageId;
      if (!receiptMessageId) throw new Error('Discord did not return a transport receipt message id');
      return state.recordTransportReceiptOutcome(message.id, 'sent', payload.reaction
        ? { reaction: payload.reaction, targetMessageId: message.id }
        : { receiptMessageId });
    } catch (error) {
      return state.recordTransportReceiptOutcome(message.id, classifyTransportReceiptError(error), { error: String(error?.message || error).slice(0, 200) });
    }
  }

  function launchTransportReceipt(message) {
    return trackReceiptWork(issueTransportReceipt(message));
  }

  function storedAttachmentInput(message) {
    const input = eventToInput(message);
    if (!message?.author?.bot || !Array.isArray(input.attachments) || input.attachments.length !== 1 ||
      input.attachments[0]?.filename !== AGENT_ATTACHMENT_FILENAME) return null;
    const stored = state.getMessage(message.id);
    if (!stored) return null;
    return { ...input, content: stored.content, attachments: stored.attachments };
  }

  async function normalizeSurfaceMessage(message, options) {
    const input = eventToInput(message);
    if (typeof input.content === 'string' && input.content.startsWith(WATCHER_NOTICE_PREFIX)) return input;
    return normalizeAgentMessage(message, input, options);
  }

  function nativeOwnerKey(message) {
    const durable = message.provider && message.nativeId ? message : state.getMessage(message.id) || message;
    return `${durable.provider}:${durable.nativeId}`;
  }

  function hasCurrentNativeAcknowledgment(message) {
    if (!message || !state.hasNativeAcknowledgment(message)) return false;
    return state.currentMessageBinding(message).current;
  }

  function ownerMessageIsTerminal(message) {
    return Boolean(message && [MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLIED, MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN,
      MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST].includes(message.state));
  }

  function ownerCanAdvance(messageId) {
    const message = state.getMessage(messageId);
    return !message || [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLIED, MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN,
      MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST].includes(message.state) ||
      (message.state === MESSAGE_STATES.SUBMITTED && hasCurrentNativeAcknowledgment(message));
  }

  function ownerBindingReady(messageId) {
    const message = state.getMessage(messageId);
    if (!message) return true;
    if (ownerMessageIsTerminal(message)) return true;
    const route = state.getMessageRoute(message.deliveryChannelId || message.channelId);
    if (route) return route.ready;
    const binding = state.getBinding(message.channelId);
    return !binding || !binding.active || binding.readiness === READINESS.READY;
  }

  function releaseReadyOwnerBlock(message) {
    const ownerKey = nativeOwnerKey(message);
    const queue = ownerQueues.get(ownerKey);
    if (!queue?.blockedMessageId || !ownerBindingReady(queue.blockedMessageId)) return;
    const blocked = state.getMessage(queue.blockedMessageId);
    if (!blocked || !ownerMessageIsTerminal(blocked)) return;
    if (queue.active?.message.id === queue.blockedMessageId) queue.active = null;
    queue.blockedMessageId = null;
    queue.blockedReason = null;
    pumpOwner(ownerKey);
  }

  function ownerQueueFor(key) {
    let queue = ownerQueues.get(key);
    if (!queue) {
      queue = { active: null, blockedMessageId: null, blockedReason: null, entries: [] };
      ownerQueues.set(key, queue);
    }
    return queue;
  }

  function ownerAdmissionOrder(messageId) {
    const rowId = state.getMessageRowId(messageId);
    return Number.isSafeInteger(rowId) ? rowId : null;
  }

  function compareOwnerEntries(left, right) {
    const discordOrder = compareRecoveryCandidates(left.queueMessage, right.queueMessage);
    if (discordOrder) return discordOrder;
    const createdAtOrder = left.queueMessage.createdAt.localeCompare(right.queueMessage.createdAt);
    if (createdAtOrder) return createdAtOrder;
    const leftAdmissionOrder = Number.isInteger(left.admissionOrder) ? left.admissionOrder : Number.MAX_SAFE_INTEGER;
    const rightAdmissionOrder = Number.isInteger(right.admissionOrder) ? right.admissionOrder : Number.MAX_SAFE_INTEGER;
    return leftAdmissionOrder - rightAdmissionOrder || left.sequence - right.sequence;
  }

  function blockingEarlierOwnerMessage(message) {
    const messages = state.listMessages();
    const currentIndex = messages.findIndex(candidate => candidate.id === message.id);
    if (currentIndex < 0) return null;
    return messages.find((candidate, candidateIndex) => sameNativeOwner(candidate, message) &&
      (isDiscordId(candidate.id) && isDiscordId(message.id)
        ? compareDiscordIds(candidate.id, message.id) < 0
        : candidateIndex < currentIndex) &&
      [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.UNCERTAIN, MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLYING].includes(candidate.state) &&
      !(candidate.state === MESSAGE_STATES.SUBMITTED && hasCurrentNativeAcknowledgment(candidate))) || null;
  }

  function removeAbortHandler(entry) {
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.onAbort = null;
  }

  function finishOwner(entry) {
    const queue = ownerQueues.get(entry.ownerKey);
    if (!queue || queue.active !== entry) return;
    if (ownerMessageIsTerminal(state.getMessage(entry.message.id))) {
      queue.blockedMessageId = null;
      queue.blockedReason = null;
      queue.active = null;
      pumpOwner(entry.ownerKey);
      return;
    }
    if (entry.dispatchBlocked) {
      queue.blockedMessageId = entry.message.id;
      queue.blockedReason = 'not_submitted';
      return;
    }
    if (!ownerCanAdvance(entry.message.id)) {
      queue.blockedMessageId = entry.message.id;
      queue.blockedReason = null;
      return;
    }
    if (!ownerBindingReady(entry.message.id)) {
      queue.blockedMessageId = entry.message.id;
      queue.blockedReason = null;
      return;
    }
    queue.blockedMessageId = null;
    queue.blockedReason = null;
    queue.active = null;
    pumpOwner(entry.ownerKey);
  }

  function releaseAcknowledged(messageId) {
    const message = state.getMessage(messageId);
    if (!message || !hasCurrentNativeAcknowledgment(message) || !ownerCanAdvance(messageId)) return false;
    const queue = ownerQueues.get(nativeOwnerKey(message));
    if (!queue) return false;
    if (queue.active?.message.id === messageId) {
      const active = queue.active;
      active.dispatchBlocked = false;
      finishOwner(active);
      return queue.active !== active;
    }
    if (queue.blockedMessageId !== messageId || !ownerBindingReady(queue.blockedMessageId)) return false;
    queue.blockedMessageId = null;
    queue.blockedReason = null;
    pumpOwner(nativeOwnerKey(message));
    return true;
  }

  function releaseHandledWithoutPostId(messageId) {
    const message = state.getMessage(messageId);
    if (!message || message.state !== MESSAGE_STATES.AGENT_HANDLED_WITHOUT_POST) return false;
    const queue = ownerQueues.get(nativeOwnerKey(message));
    if (!queue) return false;
    if (queue.active?.message.id === messageId) {
      const activeWork = nativeWork.get(messageId);
      if (activeWork) {
        activeWork.controller?.abort();
        return false;
      }
      queue.active = null;
      queue.blockedMessageId = null;
      queue.blockedReason = null;
      pumpOwner(nativeOwnerKey(message));
      return true;
    }
    if (queue.blockedMessageId !== messageId) return false;
    queue.blockedMessageId = null;
    queue.blockedReason = null;
    pumpOwner(nativeOwnerKey(message));
    return true;
  }

  function releaseHandledWithoutPost(messageId = null) {
    if (messageId !== null) return releaseHandledWithoutPostId(messageId);
    let released = false;
    for (const queue of ownerQueues.values()) {
      const messageIds = new Set([
        queue.active?.message?.id,
        queue.blockedMessageId
      ].filter(Boolean));
      for (const queuedMessageId of messageIds) {
        released = releaseHandledWithoutPostId(queuedMessageId) || released;
      }
    }
    return released;
  }

  function cancelQueuedEntry(entry) {
    if (entry.started || entry.cancelled) return;
    entry.cancelled = true;
    removeAbortHandler(entry);
    queuedNativeWork.delete(entry.message.id);
    const queue = ownerQueues.get(entry.ownerKey);
    if (queue) {
      queue.entries = queue.entries.filter(item => item !== entry);
      if (!queue.active && !queue.blockedMessageId && queue.entries.length === 0) ownerQueues.delete(entry.ownerKey);
    }
    entry.resolve({ status: 'stopped', message: state.getMessage(entry.message.id) });
  }

  function startOwnerEntry(entry) {
    entry.started = true;
    queuedNativeWork.delete(entry.message.id);
    removeAbortHandler(entry);
    let result;
    try {
      result = entry.starter(() => finishOwner(entry), entry);
    } catch (error) {
      finishOwner(entry);
      entry.reject(error);
      return;
    }
    const startedMessage = state.getMessage(entry.message.id);
    if (startedMessage?.state === MESSAGE_STATES.SUBMITTED && hasCurrentNativeAcknowledgment(startedMessage)) {
      releaseAcknowledged(entry.message.id);
    }
    Promise.resolve(result).then(entry.resolve, entry.reject);
  }

  function pumpOwner(ownerKey) {
    const queue = ownerQueues.get(ownerKey);
    if (!queue || queue.active || queue.blockedMessageId) return;
    while (queue.entries.length) {
      const entry = queue.entries.shift();
      if (entry.cancelled || entry.signal?.aborted) {
        cancelQueuedEntry(entry);
        continue;
      }
      queue.active = entry;
      startOwnerEntry(entry);
      return;
    }
    ownerQueues.delete(ownerKey);
  }

  function existingNativeWork(message, awaitExisting) {
    releaseReadyOwnerBlock(message);
    const existing = nativeWork.get(message.id)?.promise;
    if (existing) return awaitExisting ? existing : Promise.resolve({ status: 'observing', message: state.getMessage(message.id) });
    const queued = queuedNativeWork.get(message.id);
    if (!queued) return null;
    return awaitExisting ? queued.promise : Promise.resolve({ status: 'observing', message: state.getMessage(message.id) });
  }

  function enqueueOwnerWork(message, signal, starter, awaitExisting = true, returnWhenQueued = false) {
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) return existing;
    const ownerKey = nativeOwnerKey(message);
    const queue = ownerQueueFor(ownerKey);
    const queueMessage = state.getMessage(message.id) || message;
    const dispatchBlocked = queue.blockedReason === 'not_submitted';
    if (queue.blockedMessageId && ownerBindingReady(queue.blockedMessageId) && ownerCanAdvance(queue.blockedMessageId) &&
      (!dispatchBlocked || queue.blockedMessageId === message.id)) {
      if (queue.active?.message.id === queue.blockedMessageId) queue.active = null;
      queue.blockedMessageId = null;
      queue.blockedReason = null;
    }
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    promise.catch(() => {});
    const entry = {
      message,
      queueMessage,
      ownerKey,
      starter,
      signal,
      promise,
      resolve,
      reject,
      admissionOrder: ownerAdmissionOrder(queueMessage.id),
      sequence: queueSequence++,
      started: false,
      cancelled: false,
      dispatchBlocked: false,
      onAbort: null
    };
    if (!queue.active && queue.blockedMessageId === message.id && ownerBindingReady(queue.blockedMessageId)) {
      queue.blockedMessageId = null;
      queue.active = entry;
      startOwnerEntry(entry);
      return promise;
    }
    if (queue.active?.message.id === message.id && !queue.active.started) {
      queue.active = entry;
      startOwnerEntry(entry);
      return promise;
    }
    if (queue.active && queue.active.message.id === message.id && !ownerCanAdvance(message.id)) {
      queue.active = entry;
      startOwnerEntry(entry);
      return promise;
    }
    const earlier = blockingEarlierOwnerMessage(queueMessage);
    if (!queue.active && !queue.blockedMessageId && earlier && !nativeWork.has(earlier.id) && !queuedNativeWork.has(earlier.id)) {
      queue.blockedMessageId = earlier.id;
    }
    queue.entries.push(entry);
    queue.entries.sort(compareOwnerEntries);
    queuedNativeWork.set(message.id, entry);
    if (signal) {
      entry.onAbort = () => cancelQueuedEntry(entry);
      if (signal.aborted) entry.onAbort();
      else signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    pumpOwner(ownerKey);
    return returnWhenQueued ? Promise.resolve({ status: 'observing', message: state.getMessage(message.id) }) : promise;
  }

  function trackNativeWork(messageId, work, onSettled = null) {
    const tracked = Promise.resolve(work);
    nativeWork.set(messageId, { promise: tracked, controller: null });
    tracked.finally(() => {
      if (nativeWork.get(messageId)?.promise !== tracked) return;
      nativeWork.delete(messageId);
      try { onSettled?.(messageId); } catch {}
    }).catch(() => {});
    return tracked;
  }

  function startNativeWork(messageId, signal, workFactory, onSettled = null) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) return { status: 'stopped', message: null };
      return workFactory(controller.signal);
    });
    const tracked = trackNativeWork(messageId, work, onSettled);
    const entry = nativeWork.get(messageId);
    if (entry?.promise === tracked) entry.controller = controller;
    tracked.finally(() => signal?.removeEventListener('abort', onAbort)).catch(() => {});
    return tracked;
  }

  function abortNativeWork() {
    for (const entry of nativeWork.values()) entry.controller?.abort();
    for (const entry of queuedNativeWork.values()) cancelQueuedEntry(entry);
    ownerQueues.clear();
  }

  async function waitForNativeWork() {
    while (nativeWork.size) {
      await Promise.allSettled([...nativeWork.values()].map(entry => entry.promise));
    }
  }

  async function deliverReply(message, result, signal) {
    if (result.message?.state !== 'reply_ready') return result;
    if (prepareReply) {
      try {
        const preparation = prepareReply(result.message.id, signal);
        const prepared = preparation ? await preparation : preparation;
        if (prepared === ACK_WAITING) return { ...result, message: state.getMessage(result.message.id) };
      }
      catch (error) { return { ...result, message: state.getMessage(result.message.id), error }; }
      if (signal?.aborted) return { ...result, message: state.getMessage(result.message.id) };
    }
    let ready;
    try {
      ready = state.beginReply(result.message.id);
    } catch (error) {
      return { ...result, message: state.getMessage(result.message.id), error };
    }
    if (ready.sent) return { ...result, message: ready.message };
    const parts = ready.message.replyParts?.length ? ready.message.replyParts : [{ index: 0, content: ready.message.replyText, nonce: ready.message.replyNonce, state: 'sending' }];
    for (const part of parts) {
      if (part.state === 'sent') continue;
      if (signal?.aborted) return { ...result, message: state.markReplyFailure(ready.message.id, new Error('reply delivery stopped'), true, part.index) };
      try {
        state.assertMessageCurrent(ready.message.id, 'reply-send');
        if (!part.content.trim() && !part.fileManifest) {
          const skipped = state.markReplyPartSkipped(ready.message.id, part.index);
          if (skipped.state === 'replied') return { ...result, message: skipped };
          continue;
        }
        if (part.content.length > 2000) throw new Error('Discord reply part exceeds 2000 characters');
        const sent = await sendReply(message, { ...ready.message, replyText: part.content, replyNonce: part.nonce, replyPart: part });
        const replyId = sent?.id || sent?.messageId;
        if (!replyId) throw new Error('Discord did not return a message id');
        const saved = state.markReplyPartSent(ready.message.id, part.index, replyId);
        if (saved.state === 'replied') return { ...result, message: saved };
      } catch (error) {
        const unknown = classifyReplyError(error) === 'unknown';
        return { ...result, message: state.markReplyFailure(ready.message.id, error, unknown, part.index), error };
      }
    }
    return { ...result, message: state.getMessage(ready.message.id) };
  }

  function courierDispatchStatus(result) {
    if (result?.status === COURIER_OUTCOMES.SUBMITTED) return COURIER_OUTCOMES.SUBMITTED;
    if (result?.status === COURIER_OUTCOMES.NOT_SUBMITTED) return COURIER_OUTCOMES.NOT_SUBMITTED;
    return COURIER_OUTCOMES.UNCERTAIN;
  }

  function selectedCourierRoute(message) {
    if (!courierRoute || typeof courierRoute !== 'object' || typeof courierRoute.routeId !== 'string') return false;
    if (!isCourierOriginAllowed(state, message)) return false;
    const selected = state.getCourierRoute(courierRoute.routeId) || courierRoute;
    if (!selected || selected.parentChannelId !== message.channelId || selected.guildId !== message.guildId) return false;
    if (message.provider !== 'codex') return false;
    if (message.agentMessage) return selected.deliveryChannelId === message.deliveryChannelId;
    const config = state.requireConfig();
    return message.authorId === config.operatorId && (
      message.channelId === message.deliveryChannelId || selected.deliveryChannelId === message.deliveryChannelId
    );
  }

  function courierDispatchError(status) {
    return new Error(`courier dispatch ${status}`);
  }

  async function dispatchAtCourierBoundary(message, _parentProvider, dispatchOptions, selected) {
    const binding = state.currentMessageBinding(message)?.binding;
    const observerCursor = readInitialCursor(message.nativeId, binding?.sessionRoot || undefined);
    const completion = message.agentMessage ? agentCompletionCommand(message, state.dbPath, undefined, stateDir) : null;
    const prompt = codexPrompt(message, acknowledgmentCommand(message, state.dbPath), completion);
    const input = { routeId: selected.routeId, prompt, observerCursor };
    const claimed = state.beginCourierAttempt(message.id, input);
    if (!claimed.accepted) {
      const previousOutcome = claimed.outcome?.outcome;
      if (previousOutcome) {
        const current = state.authorizeCourierAttempt(message.id, claimed.attempt.attemptId, input);
        if (!current.authorized && current.status !== COURIER_RESULT_STATUSES.DUPLICATE) {
          const status = previousOutcome === COURIER_OUTCOMES.UNCERTAIN
            ? COURIER_OUTCOMES.UNCERTAIN
            : COURIER_OUTCOMES.NOT_SUBMITTED;
          return { status, error: courierDispatchError(current.status) };
        }
        return {
          status: previousOutcome,
          cursor: claimed.attempt?.observerCursor || observerCursor,
          ...(previousOutcome === COURIER_OUTCOMES.UNCERTAIN ? { error: courierDispatchError(previousOutcome) } : {})
        };
      }
      return { status: COURIER_OUTCOMES.NOT_SUBMITTED, error: courierDispatchError(claimed.status) };
    }
    dispatchOptions.onCursor?.(observerCursor);
    if (dispatchOptions.signal?.aborted) {
      state.recordCourierOutcome(message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
        reason: 'courier dispatch stopped before queue submission'
      });
      return { status: COURIER_OUTCOMES.NOT_SUBMITTED, error: courierDispatchError(COURIER_OUTCOMES.NOT_SUBMITTED) };
    }
    const authorized = state.authorizeCourierAttempt(message.id, claimed.attempt.attemptId, input);
    if (!authorized.authorized) {
      const priorOutcome = authorized.outcome?.outcome;
      if (Object.values(COURIER_OUTCOMES).includes(priorOutcome)) {
        return {
          status: priorOutcome,
          cursor: authorized.attempt?.observerCursor || observerCursor,
          ...(priorOutcome === COURIER_OUTCOMES.UNCERTAIN ? { error: courierDispatchError(priorOutcome) } : {})
        };
      }
      const status = [COURIER_RESULT_STATUSES.STALE, COURIER_RESULT_STATUSES.HELD, COURIER_RESULT_STATUSES.CONFLICT].includes(authorized.status)
        ? COURIER_OUTCOMES.NOT_SUBMITTED
        : COURIER_OUTCOMES.UNCERTAIN;
      state.recordCourierOutcome(message.id, claimed.attempt.attemptId, status, {
        reason: `courier authorization ${authorized.status}`
      });
      return { status, error: courierDispatchError(authorized.status) };
    }
    const provider = providers[authorized.route.courier.provider];
    if (!provider || typeof provider.dispatchCourier !== 'function') {
      state.recordCourierOutcome(message.id, claimed.attempt.attemptId, COURIER_OUTCOMES.NOT_SUBMITTED, {
        reason: 'courier provider has no fixed queue boundary'
      });
      return { status: COURIER_OUTCOMES.NOT_SUBMITTED, error: courierDispatchError(COURIER_OUTCOMES.NOT_SUBMITTED) };
    }
    let dispatched;
    try {
      dispatched = await provider.dispatchCourier(authorized.envelope, { signal: dispatchOptions.signal });
    } catch (error) {
      dispatched = { status: COURIER_OUTCOMES.UNCERTAIN, error };
    }
    const status = courierDispatchStatus(dispatched);
    state.authorizeCourierAttempt(message.id, claimed.attempt.attemptId, input);
    state.recordCourierOutcome(message.id, claimed.attempt.attemptId, status, {
      ...(dispatched?.error ? { error: String(dispatched.error.message || dispatched.error).slice(0, 200) } : {})
    });
    return {
      status,
      cursor: observerCursor,
      ...(dispatched?.error ? { error: dispatched.error } : {})
    };
  }

  function processAccepted(message, signal, { continueUntilFinal = true, awaitExisting = true, handoff = false, awaitDispatchOutcome = false } = {}) {
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) return existing;
    const durable = state.getMessage(message?.id) || message;
    const selected = selectedCourierRoute(durable) ? { routeId: courierRoute.routeId } : null;
    return enqueueOwnerWork(message, signal, (onNativeSettled, ownerEntry) => {
      let settleHandoff;
      let rejectHandoff;
      let settleDispatchOutcome;
      let rejectDispatchOutcome;
      const handoffPromise = handoff ? new Promise((resolve, reject) => {
        settleHandoff = resolve;
        rejectHandoff = reject;
      }) : null;
      const dispatchOutcomePromise = awaitDispatchOutcome ? new Promise((resolve, reject) => {
        settleDispatchOutcome = resolve;
        rejectDispatchOutcome = reject;
      }) : null;
      handoffPromise?.catch(() => {});
      let nativeSettled = false;
      const settleNative = () => {
        if (nativeSettled) return;
        nativeSettled = true;
        onNativeSettled();
      };
      const work = startNativeWork(message.id, signal, async taskSignal => {
        let result;
        try {
          result = await dispatchAndObserve(state, message.id, providers, {
            ...observeOptions,
            signal: taskSignal,
            continueUntilFinal,
            ...(selected ? { dispatch: (dispatchMessage, parentProvider, dispatchOptions) => dispatchAtCourierBoundary(dispatchMessage, parentProvider, dispatchOptions, selected) } : {}),
            onDispatchOutcome: outcome => {
              if (outcome?.status === 'not_submitted') {
                ownerEntry.dispatchBlocked = !hasCurrentNativeAcknowledgment(state.getMessage(message.id));
              }
              settleDispatchOutcome?.(outcome);
            },
            onSubmitted: submitted => settleHandoff?.({ status: 'observing', message: submitted })
          });
          const promoted = state.getMessage(message.id);
          if (promoted?.state === MESSAGE_STATES.REPLY_READY && result.message?.state !== MESSAGE_STATES.REPLY_READY) {
            result = { ...result, message: promoted };
          }
          if (['uncertain', 'not_submitted'].includes(result.status) && promoted?.state === MESSAGE_STATES.SUBMITTED) {
            result = await observeSubmitted(state, promoted, providers[promoted.provider], {
              ...observeOptions,
              signal: taskSignal,
              continueUntilFinal
            });
          }
        } finally {
          settleNative();
        }
        return deliverReply(message, result, taskSignal);
      }, settleNative);
      work.then(
        result => {
          settleHandoff?.(result);
          settleDispatchOutcome?.(result);
        },
        error => {
          rejectHandoff?.(error);
          rejectDispatchOutcome?.(error);
        }
      );
      if (awaitDispatchOutcome) return dispatchOutcomePromise;
      if (!handoff) return work;
      return handoffPromise;
    }, awaitExisting, handoff);
  }

  async function handleMessage(message, signal, expectedBinding = null, onIntake = null, bypassBarrier = false) {
    const childBotRejection = rejectEnrolledChildBot(message, expectedBinding, true);
    if (childBotRejection) {
      if (!childBotRejection.stale) onIntake?.(message, childBotRejection);
      return childBotRejection;
    }
    const intake = await serializeIntake(message, async () => {
      const input = storedAttachmentInput(message) || await normalizeSurfaceMessage(message, {
          fetchImpl: agentAttachmentFetch,
          signal,
          timeoutMs: agentAttachmentTimeoutMs,
          botId: connectedBotId()
        });
      const readyForLive = typeof readyForLiveIntake === 'function' ? readyForLiveIntake(message, expectedBinding) : true;
      const currentBinding = expectedBinding ? state.getBinding(expectedBinding.channelId) : null;
      const ready = readyForLive && (!expectedBinding || (
        currentBinding?.readiness === READINESS.READY && bindingIdentityMatches(expectedBinding, currentBinding)
      ));
      const result = state.acceptDiscordMessage(input, {
        ready,
        expectedBinding,
        agentToken: input.isBot && (input.content?.startsWith(AGENT_PREFIX) || input.content?.startsWith(WATCHER_NOTICE_PREFIX)) ? agentCredential() : null
      });
      if (!result.stale) onIntake?.(message, result);
      return ready ? result : { ...result, held: true };
    }, { signal, bypassBarrier });
    if (!intake.accepted) return intake;
    launchTransportReceipt(message);
    if (intake.held) return intake;
    return processAccepted(message, signal);
  }

  async function intakeMessage(message, ready = false, coverageId = null, expectedBinding = null, emitReceipt = false, signal = null, deadline = null, bypassBarrier = false) {
    const childBotRejection = rejectEnrolledChildBot(message, expectedBinding, ready, coverageId);
    if (childBotRejection) return childBotRejection;
    const intake = await serializeIntake(message, async () => {
      const input = storedAttachmentInput(message) || await normalizeSurfaceMessage(message, {
          fetchImpl: agentAttachmentFetch,
          signal,
          timeoutMs: agentAttachmentTimeoutMs,
          deadline,
          botId: connectedBotId()
        });
      const currentBinding = expectedBinding ? state.getBinding(expectedBinding.channelId) : null;
      const effectiveReady = !bypassBarrier && expectedBinding
        ? currentBinding?.readiness === READINESS.READY
        : ready;
      return state.acceptDiscordMessage(input, {
        ready: effectiveReady,
        coverageId,
        expectedBinding,
          agentToken: input.isBot && (input.content?.startsWith(AGENT_PREFIX) || input.content?.startsWith(WATCHER_NOTICE_PREFIX)) ? agentCredential() : null
      });
    }, { signal, bypassBarrier });
    if (emitReceipt && intake.accepted) launchTransportReceipt(message);
    return intake;
  }

  async function handleStoredMessage(message, signal, { continueUntilFinal = false, handoff = false, awaitDispatchOutcome = false } = {}) {
    if (!state.isInteractionMessage?.(message.id)) launchTransportReceipt(message);
    return processAccepted(message, signal, { continueUntilFinal, awaitExisting: false, handoff, awaitDispatchOutcome });
  }

  function resumeSubmitted(message, signal, { awaitExisting = false, continueUntilFinal = false } = {}) {
    if (!state.isInteractionMessage?.(message.id)) launchTransportReceipt(message);
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) {
      releaseAcknowledged(message.id);
      return existing;
    }
    const work = enqueueOwnerWork(message, signal, onNativeSettled => {
      let nativeSettled = false;
      const settleNative = () => {
        if (nativeSettled) return;
        nativeSettled = true;
        onNativeSettled();
      };
      const work = startNativeWork(message.id, signal, async taskSignal => {
        const provider = providers[message.provider];
        let result;
        try {
          result = await observeSubmitted(state, message, provider, { ...observeOptions, signal: taskSignal, continueUntilFinal });
        } finally {
          settleNative();
        }
        return deliverReply(message, result, taskSignal);
      }, settleNative);
      if (continueUntilFinal) return Promise.resolve({ status: 'observing', message: state.getMessage(message.id) });
      return work;
    }, awaitExisting, continueUntilFinal);
    releaseAcknowledged(message.id);
    return work;
  }

  async function waitForReceipts() {
    await Promise.allSettled([...receiptWork]);
  }

  return { abortNativeWork, deliverReply, handleMessage, handleStoredMessage, intakeMessage, issueTransportReceipt, processAccepted,
    releaseAcknowledged, releaseHandledWithoutPost, releaseIntake, resumeSubmitted, waitForNativeWork, waitForReceipts };
}

class DiscordGateway {
  constructor({ state, stateDir = path.dirname(state.dbPath), client, logger = () => {}, observeOptions = {}, providers, fetchHistory, recoveryOptions = {}, onReady = null, interactionFetch = globalThis.fetch, courierRoute = null } = {}) {
    this.state = state;
    this.stateDir = stateDir;
    this.logger = logger;
    this.onReady = typeof onReady === 'function' ? onReady : null;
    this.interactionFetch = interactionFetch;
    this.client = client || this.createClient();
    this.discordToken = null;
    this.acknowledgments = null;
    this.controllers = new Set();
    this.receiptControllers = new Set();
    this.inFlight = new Set();
    this.stopping = false;
    this.stopPromise = null;
    this.startPromise = null;
    this.starting = false;
    this.started = false;
    this.lifecycleEpoch = 0;
    this.connectionEpoch = 0;
    this.recoveryController = null;
    this.recoveryPromise = null;
    this.decisionRecoveryPromise = null;
    this.decisionRecoveryController = null;
    this.recoveryFollowupPromise = null;
    this.recoveryFollowupScope = null;
    this.pendingRecoveryChannels = new Set();
    this.pendingFullRecovery = false;
    this.liveCheckpointController = null;
    this.liveCheckpointPromise = null;
    this.liveIntakeCounts = new Map();
    this.liveAttachmentRecoveryTimers = new Set();
    this.attachmentIntakeBlockedChannels = new Set();
    this.attachmentIntakeRetryPendingChannels = new Set();
    this.attachmentIntakeRetryMessages = new Map();
    this.attachmentIntakeRetryInFlight = new Map();
    this.liveCheckpointRetryTimer = null;
    this.liveCheckpointRetryChannels = null;
    this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
    this.reconnectPromise = null;
    this.deferredHandoffRecoveryTimer = null;
    this.pendingHandoffRecoveryPollTimer = null;
    this.deferredHandoffRecoveryChannels = new Set();
    this.pendingHandoffRecoveryChannels = new Set();
    this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
    this.transportReady = false;
    this.interactionRecoveryPromise = null;
    this.interactionRecoveryResolve = null;
    this.fetchHistoryInjected = typeof fetchHistory === 'function';
    this.fetchHistory = fetchHistory || ((channel, options) => channel.messages?.fetch(options));
    this.historyPageLimit = Math.min(RECOVERY_LIMITS.pageSize, Math.max(1, Number(recoveryOptions.pageLimit || RECOVERY_LIMITS.pageSize)));
    this.historyMaxPages = Math.min(RECOVERY_LIMITS.maxPages, Math.max(1, Number(recoveryOptions.maxPages || RECOVERY_LIMITS.maxPages)));
    this.historyMaxMessages = Math.min(RECOVERY_LIMITS.maxMessages, Math.max(1, Number(recoveryOptions.maxMessages || RECOVERY_LIMITS.maxMessages)));
    this.recoveryTimeoutMs = Math.min(RECOVERY_LIMITS.timeoutMs, Math.max(1000, Number(recoveryOptions.timeoutMs || RECOVERY_LIMITS.timeoutMs)));
    const callbackTimeout = Number(recoveryOptions.interactionCallbackTimeoutMs);
    this.interactionCallbackTimeoutMs = Number.isFinite(callbackTimeout) && callbackTimeout > 0
      ? Math.min(3000, callbackTimeout)
      : INTERACTION_CALLBACK_TIMEOUT_MS;
    this.liveCheckpointThreshold = Math.max(1, Math.floor(this.historyMaxMessages / 2));
    this.codexSessionRoot = recoveryOptions.codexSessionRoot;
    this.ready = false;
    this.deliverAcknowledgment = createAcknowledgmentDelivery({
      state,
      send: (message, reaction) => this.sendAcknowledgment(message, reaction)
    });
    const completionFor = message => {
      if (message.watcherNotice) return watcherNoticeCompletionCommand(message, state.dbPath, undefined, this.stateDir);
      if (message.agentMessage) return agentCompletionCommand(message, state.dbPath, undefined, this.stateDir);
      return null;
    };
    this.providers = providers || {
      codex: new CodexProvider({
        acknowledgmentFor: message => acknowledgmentCommand(message, state.dbPath),
        completionFor
      }),
      claude: new ClaudeProvider({
        waitForReply: (id, options) => waitForReply(state, id, options),
        completionFor
      })
    };
    this.ordinaryNativePreflight = recoveryOptions.ordinaryNativePreflight || (async (binding, options = {}) => {
      if (binding.provider === 'codex') return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, binding.sessionRoot || this.codexSessionRoot, options);
      if (binding.provider === 'claude') {
        return probeClaudeChannel(binding.endpoint, {
          nativeId: binding.nativeId,
          generation: binding.generation,
          workspace: binding.workspace,
          endpoint: binding.endpoint
        });
      }
      throw new Error(`unsupported ordinary provider: ${binding.provider}`);
    });
    const onNativeUnavailable = observeOptions.onNativeUnavailable;
    this.consumer = createSurfaceConsumer({
      state,
      stateDir: this.stateDir,
      providers: this.providers,
      agentCredential: () => this.discordToken,
      agentBotId: () => this.client.user?.id || null,
      agentAttachmentFetch: recoveryOptions.agentAttachmentFetch,
      agentAttachmentTimeoutMs: this.recoveryTimeoutMs,
      readyForLiveIntake: () => this.ready,
      sendReply: (message, reply) => this.sendReply(message, reply),
      prepareReply: (messageId, signal) => this.prepareReply(messageId, signal),
      sendTransportReceipt: (message, receipt) => this.sendTransportReceipt(message, receipt),
      courierRoute: courierRoute || recoveryOptions.courierRoute || null,
      observeOptions: {
        ...observeOptions,
        onNativeUnavailable: (message, error, outcome) => {
          try { onNativeUnavailable?.(message, error, outcome); } catch {}
          this.handleNativeUnavailable(message, error, outcome);
        }
      }
    });
    this.decisionConsumer = createDecisionConsumer({
      state,
      interactionFetch: this.interactionFetch,
      callbackTimeoutMs: this.interactionCallbackTimeoutMs,
      waitForDispatch: (channelId, signal) => this.waitForInteractionDispatch({ channelId }, signal),
      processAccepted: (message, signal, options) => this.consumer.processAccepted(message, signal, options),
      project: (input, signal) => this.projectDecisionMessage(input, signal)
    });
    this.boundMessage = message => {
      if (this.stopping) return;
      let handoffRecovery = null;
      let route = this.state.getMessageRoute(message?.channelId);
      const authorityId = route?.binding.channelId || message?.channelId;
      if (typeof authorityId === 'string') {
        handoffRecovery = this.state.recoverInterruptedOrdinaryHandoffIntake?.(authorityId);
      }
      route = this.state.getMessageRoute(message?.channelId);
      const binding = route?.binding;
      if (route?.enrollment) {
        try { assertPublicThread(message.channel, binding, route.deliveryChannelId, this.client.user); }
        catch (error) {
          this.state.markThreadBoundary(route.deliveryChannelId, THREAD_STATES.UNAVAILABLE, error.message, null, null, binding);
          return;
        }
      }
      if (handoffRecovery?.deferred) this.scheduleDeferredHandoffRecovery(authorityId);
      else if (!handoffRecovery && binding?.active && binding.readiness === READINESS.PENDING &&
        this.state.isOrdinaryBinding?.(binding)) {
        this.scheduleDeferredHandoffRecovery(authorityId, { pendingGeneration: true });
      }
      const bindingReady = binding?.readiness === READINESS.READY && (!route?.enrollment || route.enrollment.state === THREAD_STATES.READY);
      const readyLive = this.ready && bindingReady;
      const heldReady = !this.ready && bindingReady;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = (readyLive
        ? this.consumer.handleMessage(message, controller.signal, binding, () => this.noteLiveIntake(message))
        : this.consumer.intakeMessage(message, bindingReady, null, binding, true, controller.signal).then(intake => {
          if (heldReady && !intake?.stale) this.noteLiveIntake(message);
          return intake;
        }))
        .catch(async error => {
          if (this.isAttachmentIntakeFailure(error)) {
            try {
              await this.recordLiveAttachmentGap(message, binding, error, controller.signal);
            } catch (recoveryError) {
              this.logger(`live attachment gap recovery failed: ${recoveryError.message}`);
            }
          }
          this.logger(`message handling failed: ${error.message}`);
        })
        .finally(() => {
          this.controllers.delete(controller);
        });
      this.inFlight.add(work);
      work.finally(() => this.inFlight.delete(work));
    };
    this.boundInteraction = interaction => {
      if (this.stopping) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      const work = this.handleInteraction(interaction, controller.signal)
        .catch(error => this.logger(`interaction handling failed: ${error.message}`))
        .finally(() => this.controllers.delete(controller));
      this.inFlight.add(work);
      work.finally(() => this.inFlight.delete(work));
    };
    this.boundResume = () => {
      return this.beginReconnectRecovery('resume');
    };
    this.boundDisconnect = (_error, code) => this.pauseConnection(`Discord shard disconnected${code === undefined ? '' : ` (${code})`}`);
    this.boundReconnecting = shardId => this.pauseConnection(`Discord shard reconnecting${shardId === undefined ? '' : ` (${shardId})`}`);
    this.boundShardReady = shardId => {
      if (!this.started) return Promise.resolve({ ready: false, state: this.starting ? 'starting' : 'stopped' });
      return this.beginReconnectRecovery(`shard-ready${shardId === undefined ? '' : ` (${shardId})`}`);
    };
    this.client.on('messageCreate', this.boundMessage);
    this.client.on?.('interactionCreate', this.boundInteraction);
    this.client.on?.('shardResume', this.boundResume);
    this.client.on?.('resume', this.boundResume);
    this.client.on?.('shardDisconnect', this.boundDisconnect);
    this.client.on?.('shardReconnecting', this.boundReconnecting);
    this.client.on?.('shardReady', this.boundShardReady);
  }

  async handleInteraction(interaction, signal) {
    const expectedApplicationId = this.client.application?.id || null;
    const parsedComponent = parseComponentInteraction(interaction, expectedApplicationId);
    if (parsedComponent) return this.decisionConsumer.handleParsed(parsedComponent, signal);
    const parsed = parseCsInteraction(interaction, expectedApplicationId);
    if (!parsed) return { accepted: false, reason: 'invalid-interaction' };
    const binding = this.state.getBinding(parsed.channelId);
    const ownerPid = process.pid;
    const ownerIdentity = typeof this.state.directPostOwnerIdentity === 'function'
      ? this.state.directPostOwnerIdentity(ownerPid)
      : null;
    const accepted = this.state.acceptInteraction(parsed, binding, {
      claimCallback: true,
      ownerPid,
      ownerIdentity
    });
    if (!accepted.accepted) {
      if (!accepted.duplicate) await this.sendInteractionRejection(parsed, accepted.reason, signal);
      return accepted;
    }
    const callback = accepted.callback || this.state.beginInteractionCallback(parsed.id);
    if (callback.started) {
      let result;
      try {
        result = await sendInteractionCallback(parsed, {
          signal,
          fetchImpl: this.interactionFetch,
          timeoutMs: this.interactionCallbackTimeoutMs
        });
      } catch (error) {
        result = { outcome: 'unknown', reason: String(error?.message || error).slice(0, 200) };
      }
      this.state.recordInteractionCallbackOutcome(parsed.id, result.outcome, {
        ...(result.responseMessageId ? { responseMessageId: result.responseMessageId } : {}),
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.visibility ? { visibility: result.visibility } : {}),
        ...(result.terminal ? { terminal: true } : {})
      });
    }
    const message = this.state.getMessage(parsed.id);
    if (!message) return { accepted: false, reason: 'interaction-custody-missing' };
    if (!await this.waitForInteractionDispatch(message, signal)) return { ...accepted, message, deferred: true };
    return this.consumer.processAccepted(message, signal);
  }

  async projectDecisionMessage({ click, answer }, signal) {
    if (signal?.aborted || this.stopping) throw Object.assign(new Error('decision projection stopped'), { outcome: 'not_sent' });
    const channel = await this.client.channels?.fetch?.(click.channelId);
    const message = await channel?.messages?.fetch?.(click.messageId);
    if (!message || typeof message.edit !== 'function') {
      throw Object.assign(new Error('decision question message cannot be edited'), { outcome: 'not_sent' });
    }
    if (signal?.aborted || this.stopping) throw Object.assign(new Error('decision projection stopped'), { outcome: 'not_sent' });
    const stored = this.state.getMessage(click.interactionId);
    if (stored) {
      this.state.assertMessageCurrent(click.interactionId, 'decision-projection');
    } else {
      const config = this.state.requireConfig();
      const current = this.state.getBinding(click.channelId);
      const sameBinding = Boolean(current?.active) && current.channelId === click.binding.channelId &&
        current.guildId === click.binding.guildId && current.provider === click.binding.provider &&
        current.nativeId === click.binding.nativeId && current.workspace === click.binding.workspace &&
        (current.sessionRoot || null) === (click.binding.sessionRoot || null) &&
        (current.endpoint || null) === (click.binding.endpoint || null) &&
        (current.conductorId || null) === (click.binding.conductorId || null) &&
        (current.repoKey || null) === (click.binding.repoKey || null) && current.generation === click.binding.generation;
      if (!sameBinding || config.guildId !== click.guildId || config.operatorId !== click.actorId) {
        throw new Error('decision projection authorization is no longer valid');
      }
    }
    return message.edit({ content: answer, components: [] });
  }

  async sendInteractionRejection(interaction, reason, signal) {
    try {
      return await sendInteractionCallback(interaction, {
        signal,
        fetchImpl: this.interactionFetch,
        content: interactionRejectionMessage(reason),
        ephemeral: true,
        timeoutMs: this.interactionCallbackTimeoutMs
      });
    } catch (error) {
      this.logger(`Discord interaction rejection callback failed: ${error.message}`);
      return { outcome: 'unknown', reason: String(error?.message || error).slice(0, 200) };
    }
  }

  createInteractionRecoveryBarrier() {
    if (this.interactionRecoveryPromise) return this.interactionRecoveryPromise;
    this.interactionRecoveryPromise = new Promise(resolve => {
      this.interactionRecoveryResolve = resolve;
    });
    return this.interactionRecoveryPromise;
  }

  resolveInteractionRecovery(ready) {
    const resolve = this.interactionRecoveryResolve;
    this.interactionRecoveryResolve = null;
    const promise = this.interactionRecoveryPromise;
    this.interactionRecoveryPromise = null;
    resolve?.(Boolean(ready));
    return promise;
  }

  async waitForInteractionDispatch(message, signal) {
    if (signal?.aborted || this.stopping) return false;
    const barrier = this.interactionRecoveryPromise;
    if (barrier) {
      const ready = await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish(false);
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(barrier).then(finish, () => finish(false));
      });
      if (!ready || signal?.aborted || this.stopping) return false;
    }
    const pending = [this.startPromise, this.reconnectPromise, this.recoveryPromise].filter(Boolean);
    if (pending.length) await Promise.all(pending.map(promise => Promise.resolve(promise).catch(() => null)));
    if (signal?.aborted || this.stopping) return false;
    if (!this.started) return true;
    if (!this.transportReady || !this.ready) return false;
    return this.state.getBinding(message.channelId)?.readiness === READINESS.READY;
  }

  async registerApplicationCommand() {
    return upsertGuildCsCommand(this.client.application?.commands, this.state.requireConfig().guildId);
  }

  createClient() {
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  }

  markThreadDeliveryUnavailable(message, error) {
    const stored = this.state.getMessage(message.id);
    if (!stored?.deliveryChannelId || stored.deliveryChannelId === stored.channelId) return;
    const binding = this.state.getBinding(stored.channelId);
    if (!bindingIdentityMatches(stored, binding)) return;
    const enrollment = this.state.getThreadEnrollment(stored.deliveryChannelId);
    if (!enrollment) return;
    const retryableBoundary = isRetryableFetchBoundary(enrollment.state, enrollment.detail);
    const retryableFetch = isRetryableFetchBoundary(THREAD_STATES.UNAVAILABLE, error.message);
    if (['gap', 'unavailable'].includes(enrollment.state) && !retryableBoundary) return;
    const nextState = !enrollment.adoptedAt && retryableFetch ? THREAD_STATES.PENDING : THREAD_STATES.UNAVAILABLE;
    this.state.markThreadBoundary(stored.deliveryChannelId, nextState,
      error.message, null, null, binding, undefined, undefined, enrollment);
  }

  async threadDeliveryMessage(message) {
    const stored = this.state.getMessage(message.id);
    if (!stored?.deliveryChannelId || stored.deliveryChannelId === stored.channelId) return message;
    const binding = this.state.getBinding(stored.channelId);
    const route = this.state.getMessageRoute(stored.deliveryChannelId);
    if (!route) throw Object.assign(new Error('Thread delivery has no active parent route'), { outcome: 'not_sent' });
    let channel;
    try {
      channel = message.channel?.id === stored.deliveryChannelId ? message.channel :
        await recoveryFetch(() => this.client.channels.fetch(stored.deliveryChannelId));
      assertPublicThread(channel, binding, stored.deliveryChannelId, this.client.user);
    }
    catch (error) {
      const deliveryError = error instanceof Error ? error : new Error(String(error));
      this.markThreadDeliveryUnavailable(stored, deliveryError);
      deliveryError.outcome = 'not_sent';
      throw deliveryError;
    }
    return { ...message, channelId: stored.deliveryChannelId, channel };
  }

  async sendReply(message, reply) {
    const stored = this.state.getMessage(message.id);
    const isThreadDelivery = Boolean(stored?.deliveryChannelId && stored.deliveryChannelId !== stored.channelId);
    message = await this.threadDeliveryMessage(message);
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    if (typeof reply.replyText !== 'string' || reply.replyText.length > 2000) throw new Error('Discord reply must be at most 2000 characters per message');
    if (typeof reply.replyNonce !== 'string' || reply.replyNonce.length > 25) throw new Error('Discord reply nonce must be at most 25 characters');
    const channel = message.channel || await this.client.channels?.fetch?.(message.deliveryChannelId || message.channelId);
    if (!channel?.send) throw new Error('Discord reply channel is unavailable');
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    const fileManifest = reply.replyPart?.fileManifest || null;
    const files = fileManifest
      ? [{ attachment: readDirectPostFileSnapshot(fileManifest), name: fileManifest.filename }]
      : undefined;
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    try {
      return await channel.send({
        content: reply.replyText,
        nonce: reply.replyNonce,
        enforceNonce: true,
        allowedMentions: { parse: [] },
        ...(files ? { files } : {})
      });
    } catch (error) {
      const definitiveThreadRejection = isThreadDelivery &&
        ([403, 404].includes(Number(error?.status)) || error?.code === 50013);
      if (definitiveThreadRejection) {
        const deliveryError = error instanceof Error ? error : new Error(String(error));
        this.markThreadDeliveryUnavailable(message, deliveryError);
      }
      if (!error.outcome) error.outcome = classifyReplyError(error);
      throw error;
    }
  }

  prepareReply(messageId, signal) {
    if (signal?.aborted || this.stopping) return;
    return waitForAcknowledgment(this.state, this.deliverAcknowledgment, messageId, signal);
  }

  async sendAcknowledgment(message, reaction) {
    if (this.stopping) throw new Error('Discord acknowledgment stopped');
    this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
    const interaction = this.state.isInteractionMessage?.(message.id);
    const targetMessageId = interaction ? this.state.interactionResponseTarget?.(message.id) : message.id;
    if (interaction && !targetMessageId) {
      throw Object.assign(new Error('interaction callback response target is unavailable'), {
        outcome: 'local_visibility_failure', visibility: 'local', targetMessageId: null
      });
    }
    let source = message;
    if (!source.channel && !(this.discordToken && this.client?.rest)) {
      const channel = await this.client.channels?.fetch?.(message.deliveryChannelId || message.channelId);
      if (!channel) throw new Error('Discord acknowledgment channel is unavailable');
      source = { ...message, channel };
    }
    this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
    try {
      return await this.sendTransportReceipt(source, { reaction, targetMessageId: targetMessageId || message.id });
    } catch (error) {
      if ([400, 401, 403, 404].includes(Number(error?.status))) {
        error.visibility = 'local';
        error.targetMessageId = targetMessageId || message.id;
      }
      throw error;
    }
  }

  async sendTransportReceipt(message, receipt) {
    const controller = new AbortController();
    this.receiptControllers.add(controller);
    try {
      let sendPromise;
      try {
        const stored = this.state.getMessage(message.id);
        if (stored?.deliveryChannelId && stored.deliveryChannelId !== stored.channelId) {
          message = await waitForRecoveryOperation(() => this.threadDeliveryMessage(message), controller.signal, Date.now() + this.recoveryTimeoutMs);
          this.state.assertMessageCurrent(message.id, 'transport-receipt-send');
        }
        // discord.js channel.send drops the signal and uses the shared REST retry queue.
        if (this.discordToken && this.client?.rest && typeof globalThis.fetch === 'function') {
          if (receipt.reaction) {
            const channelId = message.channelId || message.channel.id;
            const targetMessageId = receipt.targetMessageId || message.id;
            const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(targetMessageId)}/reactions/${encodeURIComponent(receipt.reaction)}/@me`;
            sendPromise = globalThis.fetch(url, {
              method: 'PUT',
              headers: {
                Authorization: `Bot ${this.discordToken}`,
                'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
                'Content-Type': 'application/json'
              },
              signal: controller.signal
            }).then(async response => {
              if (!response?.ok) {
                const retryAfter = response?.status === 429 ? await readRetryAfter(response) : null;
                await cancelResponseBody(response);
                const error = new Error('Discord acknowledgment request rejected');
                error.status = response?.status;
                if (retryAfter) {
                  error.retryAfter = retryAfter.raw;
                  error.retryAfterMs = retryAfter.milliseconds;
                }
                throw error;
              }
              await cancelResponseBody(response);
              return { id: targetMessageId, targetMessageId, reaction: receipt.reaction };
            });
          } else {
            sendPromise = sendDiscordMessage({
              token: this.discordToken, channelId: message.channelId || message.channel.id,
              content: receipt.content, nonce: receipt.nonce, signal: controller.signal,
              timeoutMs: this.recoveryTimeoutMs, allowedMentions: { parse: [], replied_user: false },
              messageReference: { message_id: message.id, fail_if_not_exists: false }
            });
          }
        } else if (this.discordToken && this.client?.rest) {
          throw new Error('Discord transport receipt fetch is unavailable');
        } else {
          const reactToFetchedMessage = async () => {
            const targetMessageId = receipt.targetMessageId || message.id;
            const source = await message.channel.messages.fetch(targetMessageId);
            this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
            return source.react(receipt.reaction);
          };
          const targetMessageId = receipt.targetMessageId || message.id;
          sendPromise = receipt.reaction
            ? Promise.resolve(message.react && targetMessageId === message.id ? message.react(receipt.reaction) : reactToFetchedMessage())
              .then(() => ({ id: targetMessageId, targetMessageId, reaction: receipt.reaction }))
            : message.channel.send({
              content: receipt.content,
              nonce: receipt.nonce,
              enforceNonce: true,
              allowedMentions: receipt.allowedMentions,
              reply: receipt.reply
            });
        }
      } catch (error) {
        sendPromise = Promise.reject(error);
      }
      return await waitForRecoveryOperation(
        () => sendPromise,
        controller.signal,
        Date.now() + this.recoveryTimeoutMs,
        () => controller.abort()
      );
    } finally {
      this.receiptControllers.delete(controller);
    }
  }

  isCurrentLifecycle(epoch) {
    return !this.stopping && this.lifecycleEpoch === epoch;
  }

  pauseLiveDispatch() {
    if (this.stopping) return;
    this.ready = false;
  }

  pauseConnection(detail) {
    if (this.stopping) return;
    this.ready = false;
    this.transportReady = false;
    this.connectionEpoch += 1;
    this.recoveryController?.abort();
    this.liveCheckpointController?.abort();
    for (const binding of this.state.listBindings().filter(item => item.active)) {
      try { this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, detail, binding); }
      catch (error) { this.logger(`Discord disconnect readiness update failed: ${error.message}`); }
    }
  }

  beginReconnectRecovery(reason) {
    if (this.stopping) return Promise.resolve({ ready: false, state: 'stopped' });
    this.transportReady = false;
    this.createInteractionRecoveryBarrier();
    const connectionEpoch = this.connectionEpoch;
    const lifecycleEpoch = this.lifecycleEpoch;
    const previousRecovery = this.recoveryPromise;
    const previousCheckpoint = this.liveCheckpointPromise;
    const task = (async () => {
      await previousRecovery?.catch(() => {});
      await previousCheckpoint?.catch(() => {});
      if (this.stopping || connectionEpoch !== this.connectionEpoch) return { ready: false, state: 'stopped' };
      const result = await this.recoverTransport('reconnect', lifecycleEpoch);
      if (this.isCurrentLifecycle(lifecycleEpoch) && !this.stopping && connectionEpoch === this.connectionEpoch && result.state !== 'stopped') {
        this.transportReady = true;
        if (result.ready) await this.reconcilePending();
        else if (this.ready) await this.reconcilePending(undefined, { readyOnly: true });
        if (!this.stopping && connectionEpoch === this.connectionEpoch) this.onReady?.();
      }
      return result;
    })().catch(error => {
      this.logger(`Discord recovery failed: ${error.message}`);
      return { ready: false, state: recoveryKind(error) || 'unavailable', error };
    });
    this.reconnectPromise = task;
    task.finally(() => {
      this.resolveInteractionRecovery(this.transportReady && this.ready);
      if (this.reconnectPromise === task) this.reconnectPromise = null;
    }).catch(() => {});
    return task;
  }

  async start(secretFile) {
    if (this.stopping) throw new Error('Discord gateway is stopping');
    if (this.startPromise) return this.startPromise;
    const epoch = ++this.lifecycleEpoch;
    this.ready = false;
    this.starting = true;
    this.started = false;
    this.createInteractionRecoveryBarrier();
    const startPromise = (async () => {
      const token = readSecret(secretFile);
      this.discordToken = token;
      await this.client.login(token);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord startup was stopped during login');
      try {
        await this.registerApplicationCommand();
      } catch (error) {
        this.logger(`Discord application command registration failed: ${error.message}`);
      }
      for (const binding of this.state.listBindings().filter(binding => binding.active)) {
        this.state.recoverInterruptedOrdinaryHandoffIntake?.(binding.channelId, binding);
      }
      const recovery = await this.recoverTransport('startup', epoch);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord startup was stopped during recovery');
      const unresolvedBindings = this.state.listBindings().filter(binding => binding.active && binding.readiness !== READINESS.READY);
      const hasEndpointUnavailableBinding = !recovery.ready && ['gap', 'unavailable'].includes(recovery.state) &&
        unresolvedBindings.length > 0 && unresolvedBindings.every(binding => {
          const watermark = this.state.getIntakeWatermark(binding.channelId);
          return watermark?.state === READINESS.UNAVAILABLE &&
            typeof watermark.detail === 'string' && (
              watermark.detail.startsWith(CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX) ||
              watermark.detail.startsWith('Codex transcript proof unavailable before event write:')
            );
        });
      if (!recovery.ready && !hasEndpointUnavailableBinding) throw new Error(`Discord intake recovery is ${recovery.state}`);
      if (hasEndpointUnavailableBinding) this.ready = true;
      this.transportReady = true;
      this.started = true;
      this.resolveInteractionRecovery(true);
      this.schedulePendingHandoffRecoveryPoll();
      this.acknowledgments = watchAcknowledgments({
        state: this.state,
        send: (message, reaction) => this.sendAcknowledgment(message, reaction),
        deliver: this.deliverAcknowledgment,
        onAcknowledged: messageId => {
          if (this.stopping) return null;
          const message = this.state.getMessage(messageId);
          if (![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message?.state)) return ACK_WAITING;
          this.consumer?.releaseAcknowledged?.(messageId);
          return this.consumer?.resumeSubmitted(message, undefined, { awaitExisting: false, continueUntilFinal: true });
        },
        logger: this.logger
      });
    })();
    this.startPromise = startPromise;
    try { return await startPromise; }
    finally {
      if (this.startPromise === startPromise) this.startPromise = null;
      this.starting = false;
      if (!this.started) this.resolveInteractionRecovery(false);
      if (!this.started) this.discordToken = null;
    }
  }

  normalizeFetchedMessage(message, channel) {
    return {
      ...message,
      guildId: message.guildId || channel.guildId || this.state.requireConfig().guildId,
      channelId: message.channelId || channel.id,
      channel
    };
  }

  historyMessages(result) {
    if (!result) return [];
    if (Array.isArray(result)) return result;
    if (typeof result.values === 'function') return [...result.values()];
    if (typeof result[Symbol.iterator] === 'function') return [...result];
    return [];
  }

  historyPermission(channel, { requireSend = false } = {}) {
    return historyPermission(channel, this.client.user, requireSend);
  }

  async recordBoundary(binding, channel, state, detail, gapFrom = null, gapTo = null, signal = null, deadline = null, expectedBoundary = undefined, expectedReadiness = undefined) {
    if (signal?.aborted || !this.isCurrentBinding(binding)) return null;
    let watermark;
    try {
      watermark = this.state.markIntakeBoundary(binding.channelId, state, detail, gapFrom, gapTo, binding, null, expectedBoundary, expectedReadiness);
    } catch (error) {
      if (!(error instanceof UnresolvedWorkError) || state !== 'ready') throw error;
      const blockedDetail = `${detail}; legacy topic migration custody is unresolved`;
      watermark = this.state.markIntakeBoundary(binding.channelId, READINESS.UNAVAILABLE, blockedDetail, gapFrom, gapTo, binding, null, expectedBoundary, expectedReadiness);
      return watermark ? { watermark, topicPublished: false, publication: null, blocked: true, error } : null;
    }
    if (!watermark) return null;
    return { watermark, topicPublished: true, publication: null };
  }

  isAttachmentIntakeFailure(error) {
    return [AGENT_ATTACHMENT_RECOVERY_KINDS.INTAKE, CODEX_VALIDATION_KINDS.DEADLINE].includes(recoveryKind(error));
  }

  async retryLiveAttachment(message, binding) {
    const route = typeof message?.channelId === 'string' ? this.state.getMessageRoute(message.channelId) : null;
    const currentBinding = route?.binding || (binding?.channelId ? this.state.getBinding(binding.channelId) : null);
    if (!this.ready || !currentBinding?.active || currentBinding.readiness !== READINESS.READY ||
      !bindingIdentityMatches(binding, currentBinding) || (route?.enrollment && !route.ready)) return { attempted: false };
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return { attempted: true, result: await this.consumer.handleMessage(message, controller.signal, currentBinding, null, true) };
    } finally {
      this.controllers.delete(controller);
      controller.abort();
    }
  }

  retryPendingLiveAttachment(channelId) {
    const existing = this.attachmentIntakeRetryInFlight.get(channelId);
    if (existing) return existing;
    const pending = this.attachmentIntakeRetryMessages.get(channelId);
    if (!pending) return Promise.resolve({ attempted: true });
    const work = (async () => {
      try {
        const retry = await this.retryLiveAttachment(pending.message, pending.binding);
        if (!retry.attempted) return retry;
        this.attachmentIntakeRetryPendingChannels.delete(channelId);
        this.attachmentIntakeRetryMessages.delete(channelId);
        this.releaseRecoveredAttachmentIntake(channelId);
        return retry;
      } catch (error) {
        this.logger(`live attachment retry failed: ${error.message}`);
        await this.recordLiveAttachmentGap(pending.message, pending.binding, error);
        return { attempted: false };
      }
    })();
    this.attachmentIntakeRetryInFlight.set(channelId, work);
    work.finally(() => this.attachmentIntakeRetryInFlight.delete(channelId)).catch(() => {});
    return work;
  }

  async recordLiveAttachmentGap(message, binding, error, signal = null) {
    const deliveryChannelId = typeof message?.channelId === 'string' ? message.channelId : binding?.channelId;
    const route = deliveryChannelId ? this.state.getMessageRoute(deliveryChannelId) : null;
    const enrollment = route?.enrollment || null;
    const childDelivery = Boolean(deliveryChannelId && binding?.channelId && deliveryChannelId !== binding.channelId);
    const clearPending = () => {
      if (!deliveryChannelId) return;
      const pending = this.attachmentIntakeRetryMessages.get(deliveryChannelId);
      if (pending && !bindingIdentityMatches(pending.binding, binding)) return;
      this.attachmentIntakeRetryPendingChannels.delete(deliveryChannelId);
      this.attachmentIntakeRetryMessages.delete(deliveryChannelId);
      this.consumer.releaseIntake(deliveryChannelId);
      this.attachmentIntakeBlockedChannels.delete(deliveryChannelId);
    };
    if (childDelivery && (!enrollment || enrollment.parentChannelId !== binding?.channelId ||
      route.binding.channelId !== binding.channelId)) {
      clearPending();
      return null;
    }
    const currentBinding = binding?.channelId ? this.state.getBinding(binding.channelId) : null;
    const bindingIsCurrent = Boolean(binding?.active && currentBinding?.active &&
      bindingIdentityMatches(binding, currentBinding));
    if (!bindingIsCurrent) {
      clearPending();
      return null;
    }
    if (signal?.aborted || this.stopping) return null;
    const intakeChannelId = deliveryChannelId || binding.channelId;
    this.attachmentIntakeBlockedChannels.add(intakeChannelId);
    this.attachmentIntakeRetryMessages.set(intakeChannelId, { message, binding });
    const watermark = childDelivery ? null : this.state.getIntakeWatermark(binding.channelId);
    const gapFrom = childDelivery
      ? enrollment.recoveredThroughId || enrollment.lastSeenId || null
      : watermark?.recovered_through_id || watermark?.last_seen_id || null;
    const detail = `live attachment intake failed for ${message?.id || 'unknown message'}: ${String(error?.message || error).slice(0, 900)}`;
    const boundary = childDelivery
      ? this.state.markThreadBoundary(intakeChannelId, THREAD_STATES.GAP, detail, gapFrom, message?.id || null, binding)
      : await this.recordBoundary(binding, null, 'gap', detail, gapFrom, message?.id || null, signal);
    if ((!childDelivery && !boundary?.watermark) || (childDelivery && !boundary) || signal?.aborted || this.stopping) return boundary;
    const recoveryTimer = setImmediate(() => {
      this.liveAttachmentRecoveryTimers.delete(recoveryTimer);
      const currentRoute = childDelivery ? this.state.getMessageRoute(intakeChannelId) : null;
      const routeIsCurrent = !childDelivery || Boolean(currentRoute?.enrollment?.active &&
        currentRoute.enrollment.threadId === intakeChannelId && currentRoute.enrollment.parentChannelId === binding.channelId &&
        currentRoute.binding.channelId === binding.channelId);
      if (this.stopping || !this.isCurrentBinding(binding) || !routeIsCurrent) {
        clearPending();
        return;
      }
      if (!childDelivery) {
        let reconciled;
        try { reconciled = this.state.reconcileIntake(binding.channelId, binding); }
        catch (recoveryError) {
          this.logger(`live attachment gap reconciliation failed: ${recoveryError.message}`);
          return;
        }
        if (!reconciled) return;
        if (!reconciled.recovered_through_id) {
          const baseline = this.state.setIntakeBaseline(binding.channelId, gapFrom || '0', 'live attachment gap recovery cursor', binding);
          if (!baseline) return;
        }
      } else {
        let reconciled;
        try { reconciled = this.state.reconcileIntake(intakeChannelId, binding); }
        catch (recoveryError) {
          this.logger(`live attachment child gap reconciliation failed: ${recoveryError.message}`);
          clearPending();
          return;
        }
        if (!reconciled) {
          clearPending();
          return;
        }
      }
      this.recoverTransport('live-attachment-gap', this.lifecycleEpoch, [intakeChannelId]).then(async recovery => {
        const recoveredRoute = childDelivery ? this.state.getMessageRoute(intakeChannelId) : null;
        const recoveredRouteIsCurrent = !childDelivery || Boolean(recoveredRoute?.enrollment?.active &&
          recoveredRoute.enrollment.threadId === intakeChannelId && recoveredRoute.enrollment.parentChannelId === binding.channelId &&
          recoveredRoute.binding.channelId === binding.channelId);
        if (this.stopping || !this.isCurrentBinding(binding) || !recoveredRouteIsCurrent) {
          clearPending();
          return;
        }
        if (!this.state.getMessage(message.id)) {
          const retry = await this.retryPendingLiveAttachment(intakeChannelId);
          if (!retry.attempted) return;
        } else {
          this.attachmentIntakeRetryPendingChannels.delete(intakeChannelId);
          this.attachmentIntakeRetryMessages.delete(intakeChannelId);
        }
        this.releaseRecoveredAttachmentIntake(intakeChannelId);
        if (recovery.ready) {
          await this.reconcilePending(undefined, { readyOnly: true });
        } else if (this.ready) {
          await this.reconcilePending(undefined, { readyOnly: true });
        }
      }).catch(recoveryError => {
        this.logger(`live attachment recovery failed: ${recoveryError.message}`);
      });
    });
    this.liveAttachmentRecoveryTimers.add(recoveryTimer);
    this.attachmentIntakeRetryPendingChannels.add(intakeChannelId);
    return boundary;
  }

  releaseRecoveredAttachmentIntake(channelId = null) {
    const candidates = channelId ? [channelId] : [...this.attachmentIntakeBlockedChannels];
    for (const blockedChannelId of candidates) {
      const route = this.state.getMessageRoute(blockedChannelId);
      const binding = route?.binding || this.state.getBinding(blockedChannelId);
      if (!binding?.active || !route?.ready) continue;
      if (this.attachmentIntakeRetryPendingChannels.has(blockedChannelId)) {
        const pending = this.attachmentIntakeRetryMessages.get(blockedChannelId);
        if (pending && this.state.getMessage(pending.message.id)) {
          this.attachmentIntakeRetryPendingChannels.delete(blockedChannelId);
          this.attachmentIntakeRetryMessages.delete(blockedChannelId);
        } else {
          void this.retryPendingLiveAttachment(blockedChannelId).catch(error => {
            this.logger(`live attachment retry scheduling failed: ${error.message}`);
          });
          continue;
        }
      }
      this.consumer.releaseIntake(blockedChannelId);
      this.attachmentIntakeBlockedChannels.delete(blockedChannelId);
    }
  }

  isPreAdoptionRetryableThread(channelId) {
    return isPreAdoptionRetryableThread(this.state.getThreadEnrollment?.(channelId));
  }

  noteLiveIntake(message) {
    const channelId = typeof message?.channelId === 'string' ? message.channelId : null;
    if (!channelId || this.stopping || !this.state.getMessageRoute(channelId)?.binding.active) return;
    if (this.isPreAdoptionRetryableThread(channelId)) return;
    const count = (this.liveIntakeCounts.get(channelId) || 0) + 1;
    this.liveIntakeCounts.set(channelId, count);
    if (count < this.liveCheckpointThreshold || this.liveCheckpointPromise || this.recoveryPromise) return;
    if (this.liveCheckpointRetryTimer) {
      const retryChannels = this.liveCheckpointRetryChannels || new Set();
      retryChannels.add(channelId);
      this.liveCheckpointRetryChannels = retryChannels;
      return;
    }
    this.liveIntakeCounts.set(channelId, 0);
    this.beginLiveCheckpoint(new Map([[channelId, count]]));
  }

  scheduleHeldLiveCheckpoints() {
    if (this.stopping || this.recoveryPromise || this.liveCheckpointPromise) return;
    const heldChannels = [...this.liveIntakeCounts.entries()]
      .filter(([channelId, count]) => count >= this.liveCheckpointThreshold && this.state.getMessageRoute(channelId)?.binding.active && !this.isPreAdoptionRetryableThread(channelId));
    if (!heldChannels.length) return;
    if (this.liveCheckpointRetryTimer) {
      const retryChannels = this.liveCheckpointRetryChannels || new Set();
      for (const [channelId] of heldChannels) retryChannels.add(channelId);
      this.liveCheckpointRetryChannels = retryChannels;
      return;
    }
    const triggeredCounts = new Map(heldChannels);
    for (const [channelId] of heldChannels) this.liveIntakeCounts.set(channelId, 0);
    this.beginLiveCheckpoint(triggeredCounts);
  }

  scheduleDeferredHandoffRecovery(channelId, { pendingGeneration = false } = {}) {
    if (this.stopping || typeof channelId !== 'string') return;
    const channels = pendingGeneration ? this.pendingHandoffRecoveryChannels : this.deferredHandoffRecoveryChannels;
    channels.add(channelId);
    if (this.deferredHandoffRecoveryTimer) return;
    const delay = this.deferredHandoffRecoveryDelayMs;
    this.deferredHandoffRecoveryDelayMs = Math.min(delay * 2, DEFERRED_HANDOFF_RECOVERY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      if (this.deferredHandoffRecoveryTimer === timer) this.deferredHandoffRecoveryTimer = null;
      if (this.stopping || (!this.deferredHandoffRecoveryChannels.size && !this.pendingHandoffRecoveryChannels.size)) return;
      const deferredChannels = [...this.deferredHandoffRecoveryChannels];
      const pendingChannels = [...this.pendingHandoffRecoveryChannels];
      this.deferredHandoffRecoveryChannels.clear();
      this.pendingHandoffRecoveryChannels.clear();
      const requeue = (channelIds, pendingGeneration = false) => {
        for (const deferredChannelId of channelIds) {
          this.scheduleDeferredHandoffRecovery(deferredChannelId, { pendingGeneration });
        }
      };
      if (this.started && !this.transportReady) {
        requeue(deferredChannels);
        requeue(pendingChannels, true);
        return;
      }
      Promise.resolve().then(async () => {
        if (this.stopping) return;
        if (this.recoveryPromise) {
          requeue(deferredChannels);
          requeue(pendingChannels, true);
          return;
        }
        const recoverableChannels = new Set();
        const reconcileOnlyChannels = new Set();
        for (const channelId of new Set([...deferredChannels, ...pendingChannels])) {
          const binding = this.state.getBinding(channelId);
          const recovery = this.state.recoverInterruptedOrdinaryHandoffIntake?.(channelId, binding);
          if (recovery?.deferred) {
            this.deferredHandoffRecoveryChannels.add(channelId);
          } else if (recovery && binding?.active) {
            recoverableChannels.add(channelId);
          } else if (binding?.active && this.state.isOrdinaryBinding?.(binding) &&
            [READINESS.PENDING, READINESS.RECOVERING].includes(binding.readiness)) {
            recoverableChannels.add(channelId);
          } else if (binding?.active && binding.readiness === READINESS.READY) {
            reconcileOnlyChannels.add(channelId);
          }
        }
        if (recoverableChannels.size) {
          const recovery = await this.recoverTransport('ordinary-handoff', this.lifecycleEpoch, recoverableChannels);
          if (recovery.ready) await this.reconcilePending(undefined, { channelIds: recoverableChannels });
          else if (this.ready) await this.reconcilePending(undefined, { readyOnly: true, channelIds: recoverableChannels });
        }
        if (reconcileOnlyChannels.size) {
          await this.reconcilePending(undefined, {
            allowPaused: !this.ready,
            readyOnly: true,
            channelIds: reconcileOnlyChannels
          });
        }
      }).catch(error => this.logger(`Deferred ordinary handoff recovery failed: ${error.message}`)).finally(() => {
        if (this.stopping) return;
        if (this.deferredHandoffRecoveryChannels.size || this.pendingHandoffRecoveryChannels.size) {
          if (this.deferredHandoffRecoveryChannels.size) requeue([...this.deferredHandoffRecoveryChannels]);
          if (this.pendingHandoffRecoveryChannels.size) requeue([...this.pendingHandoffRecoveryChannels], true);
        } else {
          this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
        }
      });
    }, delay);
    timer.unref?.();
    this.deferredHandoffRecoveryTimer = timer;
  }

  schedulePendingHandoffRecoveryPoll() {
    if (this.stopping || !this.started || this.pendingHandoffRecoveryPollTimer) return;
    const timer = setTimeout(() => {
      if (this.pendingHandoffRecoveryPollTimer === timer) this.pendingHandoffRecoveryPollTimer = null;
      if (this.stopping || !this.started) return;
      const pendingHandoffChannels = new Set(this.state.listPendingOrdinaryHandoffChannels?.() || []);
      for (const binding of this.state.listBindings?.() || []) {
        if (binding.active && binding.readiness === READINESS.PENDING && this.state.isOrdinaryBinding?.(binding)) {
          pendingHandoffChannels.add(binding.channelId);
        }
      }
      for (const channelId of pendingHandoffChannels) {
        this.scheduleDeferredHandoffRecovery(channelId, { pendingGeneration: true });
      }
      this.schedulePendingHandoffRecoveryPoll();
    }, PENDING_HANDOFF_RECOVERY_POLL_MS);
    timer.unref?.();
    this.pendingHandoffRecoveryPollTimer = timer;
  }

  beginLiveCheckpoint(triggeredCounts = new Map(), { allowPendingRecovery = true } = {}) {
    if (this.liveCheckpointPromise || this.stopping || this.recoveryPromise) return;
    const controller = new AbortController();
    const epoch = this.lifecycleEpoch;
    this.liveCheckpointController = controller;
    let advancedChannels = new Set();
    const checkpoint = this.checkpointHealthyIntake(controller.signal, epoch, triggeredCounts)
      .then(async result => {
        advancedChannels = result instanceof Set ? result : new Set();
        const threads = [...advancedChannels].filter(channelId => this.state.getThreadEnrollment(channelId)?.active);
        if (threads.length) {
          if (!controller.signal.aborted && this.isCurrentLifecycle(epoch)) {
            await this.reconcilePending(undefined, { readyOnly: true, channelIds: threads });
          }
        }
        return result;
      })
      .catch(error => {
        if (recoveryKind(error) !== CODEX_VALIDATION_KINDS.STOPPED) this.logger(`Discord live intake checkpoint failed: ${error.message}`);
      })
      .finally(() => {
        if (this.liveCheckpointPromise === checkpoint) this.liveCheckpointPromise = null;
        if (this.liveCheckpointController === controller) this.liveCheckpointController = null;
        if (this.stopping) return;
        const deferredChannels = [...this.liveIntakeCounts.entries()]
          .filter(([channelId, count]) => count >= this.liveCheckpointThreshold && this.state.getMessageRoute(channelId)?.binding.active);
        const deferredCounts = new Map(deferredChannels);
        for (const [channelId] of deferredChannels) this.liveIntakeCounts.set(channelId, 0);
        for (const [channelId, count] of triggeredCounts) {
          if (advancedChannels.has(channelId) || !this.state.getMessageRoute(channelId)?.binding.active) continue;
          const currentCount = this.liveIntakeCounts.get(channelId) || 0;
          const deferredCount = deferredCounts.get(channelId);
          if (deferredCount === undefined) this.liveIntakeCounts.set(channelId, currentCount + count);
          else deferredCounts.set(channelId, deferredCount + count);
        }
        for (const [channelId, count] of this.liveIntakeCounts) {
          if (count < this.liveCheckpointThreshold || !this.state.getMessageRoute(channelId)?.binding.active) continue;
          deferredCounts.set(channelId, count);
          this.liveIntakeCounts.set(channelId, 0);
        }
        for (const channelId of deferredCounts.keys()) {
          if (!this.isPreAdoptionRetryableThread(channelId)) continue;
          deferredCounts.delete(channelId);
          this.liveIntakeCounts.delete(channelId);
        }
        if (this.recoveryPromise) {
          for (const [channelId, count] of deferredCounts) {
            const currentCount = this.liveIntakeCounts.get(channelId) || 0;
            this.liveIntakeCounts.set(channelId, Math.max(currentCount, count));
          }
          return;
        }
        if (!deferredCounts.size) {
          this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
          return;
        }
        const immediateCounts = new Map();
        for (const [channelId, count] of deferredCounts) {
          const pendingRecovery = allowPendingRecovery && this.state.getThreadEnrollment(channelId)?.state === THREAD_STATES.PENDING && !this.isPreAdoptionRetryableThread(channelId);
          if (!advancedChannels.has(channelId) && !pendingRecovery) continue;
          immediateCounts.set(channelId, count);
          deferredCounts.delete(channelId);
        }
        if (deferredCounts.size) this.scheduleLiveCheckpointRetry(deferredCounts);
        else this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
        if (immediateCounts.size) this.beginLiveCheckpoint(immediateCounts, { allowPendingRecovery: false });
      });
    this.liveCheckpointPromise = checkpoint;
  }

  scheduleLiveCheckpointRetry(deferredCounts) {
    if (!deferredCounts?.size || this.stopping) return;
    const retryChannels = this.liveCheckpointRetryChannels || new Set();
    for (const [channelId, count] of deferredCounts) {
      const currentCount = this.liveIntakeCounts.get(channelId) || 0;
      this.liveIntakeCounts.set(channelId, Math.max(currentCount, count));
      retryChannels.add(channelId);
    }
    this.liveCheckpointRetryChannels = retryChannels;
    if (this.liveCheckpointRetryTimer) return;
    const retryDelay = Math.min(this.liveCheckpointRetryDelayMs || LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS, LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS);
    this.liveCheckpointRetryDelayMs = Math.min(retryDelay * 2, LIVE_CHECKPOINT_RETRY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      if (this.liveCheckpointRetryTimer === timer) this.liveCheckpointRetryTimer = null;
      const channels = this.liveCheckpointRetryChannels || new Set();
      this.liveCheckpointRetryChannels = null;
      if (this.stopping || this.recoveryPromise || this.liveCheckpointPromise) return;
      const retryCounts = new Map();
      for (const channelId of channels) {
        if (!this.state.getMessageRoute(channelId)?.binding.active) continue;
        if (this.isPreAdoptionRetryableThread(channelId)) continue;
        const count = this.liveIntakeCounts.get(channelId) || 0;
        if (count < this.liveCheckpointThreshold) continue;
        retryCounts.set(channelId, count);
        this.liveIntakeCounts.set(channelId, 0);
      }
      if (retryCounts.size) this.beginLiveCheckpoint(retryCounts, { allowPendingRecovery: false });
    }, retryDelay);
    timer.unref?.();
    this.liveCheckpointRetryTimer = timer;
  }

  async checkpointHealthyIntake(signal, lifecycleEpoch, triggeredCounts = new Map()) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const triggeredChannels = triggeredCounts instanceof Map ? new Set(triggeredCounts.keys()) : new Set();
    const bindings = this.state.listBindings().filter(binding => binding.active
      && binding.readiness === READINESS.READY
      && (!triggeredChannels.size || triggeredChannels.has(binding.channelId)));
    const advancedChannels = new Set();
    for (const binding of bindings) {
      if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord live intake checkpoint was stopped');
      const watermark = this.state.getIntakeWatermark(binding.channelId);
      if (!watermark?.recovered_through_id || typeof this.state.hasIntakeEvidence !== 'function') continue;
      if (typeof this.client?.channels?.fetch !== 'function') continue;
      let channel;
      try {
        channel = await waitForRecoveryOperation(() => this.client.channels.fetch(binding.channelId), signal, deadline);
        if (!channel || typeof channel.messages?.fetch !== 'function') continue;
        const permission = this.historyPermission(channel, { requireSend: this.state.isOrdinaryBinding?.(binding) });
        if (!permission.known || !permission.allowed) continue;
        let after = watermark.recovered_through_id;
        let pages = 0;
        let total = 0;
        let complete = false;
        while (pages < this.historyMaxPages && total < this.historyMaxMessages && Date.now() < deadline) {
          if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Discord live intake checkpoint was stopped');
          const page = this.historyMessages(await waitForRecoveryOperation(
            () => this.fetchHistory(channel, { limit: this.historyPageLimit, after, signal }),
            signal,
            deadline
          ));
          pages += 1;
          if (!page.length) { complete = true; break; }
          if (page.some(message => typeof message?.id !== 'string' || message.id.length === 0)) break;
          page.sort((left, right) => compareDiscordIds(left?.id, right?.id));
          const fresh = page.filter(message => typeof message?.id === 'string' && compareDiscordIds(message.id, after) > 0);
          if (!fresh.length) { complete = true; break; }
          for (const message of fresh) {
            if (total >= this.historyMaxMessages) break;
            if (!this.state.hasIntakeEvidence(message.id)) {
              complete = false;
              break;
            }
            after = message.id;
            total += 1;
          }
          if (!complete && total < this.historyMaxMessages && fresh.some(message => !this.state.hasIntakeEvidence(message.id))) break;
          if (total >= this.historyMaxMessages) {
            const consumedPage = after === fresh[fresh.length - 1].id;
            if (page.length < this.historyPageLimit && consumedPage) complete = true;
            break;
          }
          if (page.length < this.historyPageLimit) { complete = true; break; }
        }
        if (!complete || !after) continue;
        const checkpointed = this.state.checkpointIntake(binding.channelId, after, binding);
        if (checkpointed?.recovered_through_id && compareDiscordIds(checkpointed.recovered_through_id, watermark.recovered_through_id) > 0) {
          advancedChannels.add(binding.channelId);
        }
      } catch (error) {
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) throw error;
      }
    }
    for (const enrollment of this.state.listThreadEnrollments()) {
      if (!enrollment.active || ![THREAD_STATES.READY, THREAD_STATES.PENDING].includes(enrollment.state) ||
          (triggeredChannels.size && !triggeredChannels.has(enrollment.threadId))) continue;
      if (this.isPreAdoptionRetryableThread(enrollment.threadId)) continue;
      const checkpointOnly = enrollment.state === THREAD_STATES.READY;
      const recovered = await recoverThread(this, enrollment, signal, lifecycleEpoch, waitForRecoveryOperation, checkpointOnly, deadline);
      if (recovered) {
        advancedChannels.add(enrollment.threadId);
      } else if (checkpointOnly && this.state.getThreadEnrollment(enrollment.threadId)?.state === THREAD_STATES.PENDING) {
        const currentCount = this.liveIntakeCounts.get(enrollment.threadId) || 0;
        this.liveIntakeCounts.set(enrollment.threadId, Math.max(currentCount, this.liveCheckpointThreshold));
      }
    }
    return advancedChannels;
  }

  isCurrentBinding(binding) {
    return bindingIdentityMatches(binding, this.state.getBinding(binding.channelId));
  }

  handleNativeUnavailable(message, error, outcome) {
    if (message?.provider !== 'claude' || outcome?.endpointUnavailable !== true || this.stopping) return;
    const binding = this.state.getBinding(message.channelId);
    if (!binding || !binding.active || binding.provider !== 'claude' || binding.nativeId !== message.nativeId ||
      binding.generation !== message.generation || binding.workspace !== message.workspace || binding.endpoint !== message.endpoint ||
      !this.state.isOrdinaryBinding(binding)) return;
    const detail = `${CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX} ${String(error?.message || error || 'unknown error').slice(0, 900)}`;
    const demoted = this.state.setBindingReadiness(binding.channelId, READINESS.UNAVAILABLE, detail, binding);
    if (!demoted || this.stopping) return;
    const lifecycleEpoch = this.lifecycleEpoch;
    const recoverAndReconcile = async () => {
      let result = await this.recoverTransport('Claude endpoint unavailable', lifecycleEpoch);
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return result;
      let current = this.state.getBinding(binding.channelId);
      const matchesBinding = current?.active && current.provider === 'claude' && current.nativeId === binding.nativeId &&
        current.generation === binding.generation && current.workspace === binding.workspace && current.endpoint === binding.endpoint;
      if (matchesBinding && current.readiness === READINESS.READY) return this.reconcilePending();
      if (!matchesBinding || current.readiness !== READINESS.UNAVAILABLE) return result;

      result = await this.recoverTransport('Claude endpoint unavailable follow-up', lifecycleEpoch);
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return result;
      current = this.state.getBinding(binding.channelId);
      const recovered = current?.active && current.provider === 'claude' && current.nativeId === binding.nativeId &&
        current.generation === binding.generation && current.workspace === binding.workspace && current.endpoint === binding.endpoint &&
        current.readiness === READINESS.READY;
      return recovered ? this.reconcilePending() : result;
    };
    recoverAndReconcile().catch(recoveryError => {
      this.logger(`Claude endpoint recovery failed: ${recoveryError.message}`);
    });
  }

  async verifyOrdinaryNative(binding, options = {}) {
    if (!this.state.isOrdinaryBinding?.(binding)) return null;
    if (!this.providers[binding.provider] || typeof this.providers[binding.provider].dispatch !== 'function') {
      throw new Error(`${binding.provider} delivery provider is unavailable for ordinary binding`);
    }
    const proof = await this.ordinaryNativePreflight(binding, options);
    if (options.signal?.aborted) throw recoveryError(CODEX_VALIDATION_KINDS.STOPPED, 'Codex native preflight was stopped');
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Codex native preflight deadline exceeded');
    if (!proof || typeof proof !== 'object') throw new Error(`${binding.provider} native preflight returned no proof`);
    if (!this.isCurrentBinding(binding)) throw recoveryError('stale', `ordinary ${binding.provider} binding changed during native preflight`);
    const recorded = this.state.recordOrdinaryPreflight(binding, proof);
    if (!recorded) throw recoveryError('stale', `ordinary ${binding.provider} binding changed before native preflight was recorded`);
    return proof;
  }

  async recoverInbound(signal, reason, lifecycleEpoch = this.lifecycleEpoch, channelIds = null, recoveryDeadline = null) {
    const deadline = recoveryDeadline ?? (Date.now() + this.recoveryTimeoutMs);
    let baseReason = String(reason || '');
    let previousReason;
    do {
      previousReason = baseReason;
      baseReason = baseReason.replace(/(?: full follow-up| boundary retry| follow-up)$/, '');
    } while (baseReason !== previousReason);
    const selectedChannels = channelIds ? new Set(channelIds) : null;
    const bindings = this.state.listBindings().filter(binding => binding.active &&
      (!selectedChannels || selectedChannels.has(binding.channelId)));
    const classifyReadiness = (currentBinding, currentBoundary) => {
      if (currentBinding?.readiness === READINESS.READY && currentBoundary?.state === READINESS.READY) return READINESS.READY;
      if (currentBinding?.readiness === READINESS.GAP || currentBoundary?.state === READINESS.GAP) return READINESS.GAP;
      if (currentBinding?.readiness === READINESS.UNAVAILABLE) return READINESS.UNAVAILABLE;
      if (currentBoundary?.state === READINESS.UNAVAILABLE &&
          !isRetryableFetchBoundary(currentBoundary.state, currentBoundary.detail)) return READINESS.UNAVAILABLE;
      if (currentBinding?.readiness === READINESS.PENDING || currentBoundary?.state === READINESS.PENDING) return READINESS.PENDING;
      if (isRetryableFetchBoundary(currentBoundary?.state, currentBoundary?.detail)) return READINESS.PENDING;
      if (currentBoundary?.state === READINESS.UNAVAILABLE) return READINESS.UNAVAILABLE;
      return null;
    };
    const isInterruptedRetryBoundary = boundary => boundary?.state === READINESS.PENDING &&
      typeof boundary.detail === 'string' &&
      boundary.detail.endsWith('retry after Discord HTTP 503');
    const isRetryableRecoveryBoundary = boundary => boundary &&
      (isRetryableFetchBoundary(boundary.state, boundary.detail) || isInterruptedRetryBoundary(boundary));
    let failure = null;
    for (const binding of bindings) {
      if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      if (Date.now() >= deadline) {
        const watermark = this.state.getIntakeWatermark(binding.channelId);
        if (isRetryableRecoveryBoundary(watermark)) {
          if (isInterruptedRetryBoundary(watermark)) {
            failure ||= { ready: false, state: 'unavailable' };
            continue;
          }
          const expired = this.state.markIntakeBoundary(binding.channelId, READINESS.UNAVAILABLE,
            watermark.detail || `${reason} intake unavailable`, watermark.gap_from, watermark.gap_to,
            binding, null, watermark, binding.readiness);
          if (expired) failure ||= { ready: false, state: 'unavailable' };
          else {
            const currentBinding = this.state.getBinding(binding.channelId);
            const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
            const currentState = classifyReadiness(currentBinding, currentBoundary);
            failure ||= { ready: false, state: currentState || 'unavailable' };
          }
        } else {
          await this.recordBoundary(binding, null, 'gap', `${reason} recovery exceeded ${this.recoveryTimeoutMs}ms`, null, null, signal, deadline, watermark);
          failure ||= { ready: false, state: 'gap' };
        }
        continue;
      }
      const handoffRecovery = this.state.recoverInterruptedOrdinaryHandoffIntake?.(binding.channelId, binding);
      if (handoffRecovery?.deferred) {
        this.scheduleDeferredHandoffRecovery(binding.channelId);
        continue;
      }
      const recovering = this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, `${reason} intake recovery in progress`, binding);
      if (!recovering) {
        const currentBinding = this.state.getBinding(binding.channelId);
        const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
        const currentState = classifyReadiness(currentBinding, currentBoundary);
        if (currentState === READINESS.READY) continue;
        if (currentState === READINESS.PENDING && !this.stopping) {
          this.recoverTransport(reason, lifecycleEpoch, [binding.channelId], 0, deadline).catch(error => {
            this.logger(`Discord intake readiness retry failed: ${error.message}`);
          });
        }
        failure ||= { ready: false, state: currentState || 'unavailable' };
        continue;
      }
      let watermark = this.state.getIntakeWatermark(binding.channelId);
      let ownedBoundary = watermark;
      let ownedReadiness = recovering.readiness;
      const currentRecovery = () => this.isCurrentBinding(binding) &&
        this.state.getBinding(binding.channelId)?.readiness === ownedReadiness;
      const classifyCurrentReadiness = () => {
        if (!this.isCurrentBinding(binding)) return null;
        const currentBinding = this.state.getBinding(binding.channelId);
        const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
        const state = classifyReadiness(currentBinding, currentBoundary);
        return state ? { state, binding: currentBinding, watermark: currentBoundary } : null;
      };
      const adoptCurrentReadiness = () => {
        const current = classifyCurrentReadiness();
        if (!current) return null;
        if (current.state === READINESS.READY || current.state === READINESS.PENDING) {
          ownedReadiness = current.state;
          ownedBoundary = current.watermark;
          watermark = current.watermark;
        }
        return current;
      };
      const queueRecoveryIfPending = () => {
        if (this.stopping) return;
        const current = classifyCurrentReadiness();
        if (current?.state !== READINESS.PENDING) return;
        return this.recoverTransport(reason, lifecycleEpoch, [binding.channelId], 0, deadline).then(recoveryFailure => {
          if (recoveryFailure) return null;
          const recoveredBoundary = this.state.getIntakeWatermark(binding.channelId);
          if (recoveredBoundary?.state !== READINESS.READY) return null;
          ownedReadiness = recoveredBoundary.state;
          return { watermark: recoveredBoundary };
        }).catch(error => {
          this.logger(`Discord intake boundary retry failed: ${error.message}`);
          return null;
        });
      };
      const recordOwnedBoundary = async (owner, channel, nextState, detail, gapFrom, gapTo, signal, deadline, expectedBoundary) => {
        if (nextState === READINESS.GAP || nextState === READINESS.UNAVAILABLE) {
          if (!currentRecovery()) {
            const current = adoptCurrentReadiness();
            if (current?.state === READINESS.READY) return { watermark: current.watermark, concurrentReady: true };
            if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
            return null;
          }
          const currentBoundary = this.state.getIntakeWatermark(binding.channelId);
          if (currentBoundary?.state === READINESS.GAP || currentBoundary?.state === READINESS.UNAVAILABLE) return null;
          if (currentBoundary) {
            expectedBoundary = currentBoundary;
            gapFrom = currentBoundary.recovered_through_id;
          }
        }
        const result = await this.recordBoundary(owner, channel, nextState, detail, gapFrom, gapTo, signal, deadline, expectedBoundary, ownedReadiness);
        if (result?.watermark) ownedReadiness = result.watermark.state;
        if (!result) {
          const current = adoptCurrentReadiness();
          if (current?.state === READINESS.READY) return { watermark: current.watermark, concurrentReady: true };
          queueRecoveryIfPending();
        }
        return result;
      };
      let retryBoundary = null;
      if (isRetryableRecoveryBoundary(watermark)) {
        retryBoundary = watermark;
      }
      if (watermark && ['gap', 'unavailable'].includes(watermark.state) && !retryBoundary) {
        const terminalReadiness = watermark.state === READINESS.GAP ? READINESS.GAP : READINESS.UNAVAILABLE;
        this.state.setBindingReadiness(binding.channelId, terminalReadiness,
          watermark.detail || `${reason} intake ${watermark.state}`, binding);
        failure ||= { ready: false, state: watermark.state };
        continue;
      }
      let channel;
      let recoveryAttempted = false;
      try {
        channel = await waitForRecoveryOperation(() => {
          if (retryBoundary) {
            const retrying = this.state.markIntakeBoundary(binding.channelId, 'pending', `${reason} retry after Discord HTTP 503`,
              retryBoundary.gap_from, retryBoundary.gap_to, binding, null, retryBoundary, ownedReadiness);
            if (!retrying) throw recoveryError('stale', 'Discord intake boundary changed before channel recovery');
            watermark = retrying;
            ownedBoundary = retrying;
            ownedReadiness = retrying.state;
            retryBoundary = null;
          }
          recoveryAttempted = true;
          return recoveryFetch(() => this.client.channels.fetch(binding.channelId));
        }, signal, deadline);
        if (!channel) throw new Error('Discord channel is unavailable');
      } catch (error) {
        const kind = recoveryKind(error);
        if (kind === CODEX_VALIDATION_KINDS.STOPPED) return { ready: false, state: 'stopped' };
        if (kind === CODEX_VALIDATION_KINDS.DEADLINE && retryBoundary && !recoveryAttempted) {
          const expired = this.state.markIntakeBoundary(binding.channelId, READINESS.UNAVAILABLE,
            retryBoundary.detail || `${reason} retry after Discord HTTP 503`, retryBoundary.gap_from, retryBoundary.gap_to,
            binding, null, retryBoundary, ownedReadiness);
          if (expired) failure ||= { ready: false, state: 'unavailable' };
          else {
            const current = adoptCurrentReadiness();
            if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
            failure ||= { ready: false, state: current?.state || 'unavailable' };
          }
          continue;
        }
        if (kind === 'stale') {
          const current = adoptCurrentReadiness();
          if (current?.state === READINESS.READY) continue;
          if (current?.state === READINESS.PENDING) {
            retryBoundary = current.watermark;
            queueRecoveryIfPending();
          }
          failure ||= { ready: false, state: current?.state || 'unavailable', error };
          continue;
        }
        const recorded = await recordOwnedBoundary(binding, null, kind === CODEX_VALIDATION_KINDS.DEADLINE ? 'gap' : 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
        if (recorded?.watermark) ownedBoundary = recorded.watermark;
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: kind === CODEX_VALIDATION_KINDS.DEADLINE ? 'gap' : 'unavailable', error };
        continue;
      }
      if (!currentRecovery()) {
        const current = adoptCurrentReadiness();
        if (current?.state === READINESS.READY) continue;
        if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
        failure ||= { ready: false, state: current?.state || 'unavailable' };
        continue;
      }
      const ordinary = this.state.isOrdinaryBinding?.(binding);
      if (ordinary && channel.guildId && channel.guildId !== binding.guildId) {
        const error = new Error('Discord channel is outside the configured guild');
        const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
        if (recorded?.watermark) ownedBoundary = recorded.watermark;
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (ordinary) {
        const preflightController = new AbortController();
        const relayAbort = () => preflightController.abort();
        signal?.addEventListener('abort', relayAbort, { once: true });
        try {
          await waitForRecoveryOperation(
            () => this.verifyOrdinaryNative(binding, { signal: preflightController.signal, deadline }),
            signal,
            deadline,
            () => preflightController.abort()
          );
        } catch (error) {
          const kind = recoveryKind(error);
          if (kind === CODEX_VALIDATION_KINDS.STOPPED) return { ready: false, state: 'stopped' };
          if (kind === 'stale') {
            const current = adoptCurrentReadiness();
            if (current?.state === READINESS.READY) continue;
            if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
            failure ||= { ready: false, state: current?.state || 'unavailable', error };
            continue;
          }
          const preflightReason = ['Claude endpoint unavailable', 'ordinary-bind', 'reconnect', 'startup'].includes(baseReason);
          let detail = error.message;
          if (preflightReason && binding.provider === 'claude') {
            detail = `${CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX} ${error.message}`;
          } else if (preflightReason && binding.provider === 'codex') {
            detail = `Codex transcript proof unavailable before event write: ${error.message}`;
          }
          const recorded = await recordOwnedBoundary(binding, channel, kind === 'deadline' ? 'gap' : 'unavailable', detail, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
          if (recorded?.watermark) ownedBoundary = recorded.watermark;
          if (!recorded?.concurrentReady) failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
          continue;
        } finally {
          signal?.removeEventListener('abort', relayAbort);
          preflightController.abort();
        }
      }
      if (!ordinary && !conductorMarkerMatchesTopic(channel.topic, binding)) {
        const error = new Error('Discord channel topic does not identify the current conductor and native generation');
        const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
        if (recorded?.watermark) ownedBoundary = recorded.watermark;
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!this.fetchHistoryInjected && typeof channel.messages?.fetch !== 'function') {
        const error = new Error('Discord history fetch is unavailable for intake recovery');
        const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
        if (recorded?.watermark) ownedBoundary = recorded.watermark;
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      const permission = this.historyPermission(channel, { requireSend: ordinary });
      if (!permission.known || !permission.allowed) {
        let detail = 'Discord channel history permission is unknown';
        if (permission.known && ordinary) detail = 'Discord channel lacks history or reply permission';
        else if (permission.known) detail = 'Discord channel lacks ViewChannel or ReadMessageHistory';
        const error = new Error(detail);
        const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
        if (recorded?.watermark) ownedBoundary = recorded.watermark;
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!watermark?.recovered_through_id) {
        let baseline;
        try { baseline = this.historyMessages(await waitForRecoveryOperation(() => recoveryFetch(() => this.fetchHistory(channel, { limit: 1, signal })), signal, deadline)); }
        catch (error) {
          const kind = recoveryKind(error);
          if (kind === CODEX_VALIDATION_KINDS.STOPPED) return { ready: false, state: 'stopped' };
          const recorded = await recordOwnedBoundary(binding, channel, kind === CODEX_VALIDATION_KINDS.DEADLINE ? 'gap' : 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
          if (recorded?.watermark) ownedBoundary = recorded.watermark;
          if (!recorded?.concurrentReady) failure ||= { ready: false, state: kind === CODEX_VALIDATION_KINDS.DEADLINE ? 'gap' : 'unavailable', error };
          continue;
        }
        if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
        if (!currentRecovery()) {
          const current = adoptCurrentReadiness();
          if (current?.state === READINESS.READY) continue;
          if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
          failure ||= { ready: false, state: current?.state || 'unavailable' };
          continue;
        }
        const fetchedBoundary = this.state.getIntakeWatermark(binding.channelId);
        if (fetchedBoundary?.state === READINESS.GAP || fetchedBoundary?.state === READINESS.UNAVAILABLE) {
          failure ||= { ready: false, state: fetchedBoundary.state };
          continue;
        }
        if (fetchedBoundary) {
          ownedBoundary = fetchedBoundary;
          watermark = fetchedBoundary;
        }
        if (baseline.some(message => typeof message?.id !== 'string' || !message.id)) {
          const error = new Error('Discord history message has no stable ID');
          const recorded = await recordOwnedBoundary(binding, channel, 'unavailable', error.message, ownedBoundary?.recovered_through_id, null, signal, deadline, ownedBoundary);
          if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'unavailable', error };
          continue;
        }
        const newest = baseline.sort((a, b) => compareDiscordIds(b.id, a.id))[0];
        if (newest?.id) {
          const baselineWatermark = this.state.setIntakeBaseline(binding.channelId, newest.id, `${reason} cutoff excludes pre-adoption backlog`, binding, ownedBoundary, ownedReadiness);
          if (!baselineWatermark) {
            const current = adoptCurrentReadiness();
            if (current?.state === READINESS.READY) continue;
            queueRecoveryIfPending();
            failure ||= { ready: false, state: current?.state || 'unavailable' };
            continue;
          }
          ownedBoundary = baselineWatermark;
        } else {
          watermark = this.state.getIntakeWatermark(binding.channelId);
          if (!watermark?.last_seen_id) {
            const boundary = await recordOwnedBoundary(binding, channel, 'ready', `${reason} empty channel baseline`, null, null, signal, deadline, ownedBoundary);
            if (boundary?.watermark) ownedBoundary = boundary.watermark;
            if (!boundary || (!boundary.concurrentReady && (boundary.stale || boundary.blocked))) {
              failure ||= { ready: false, state: 'unavailable', error: boundary?.error };
            }
            continue;
          }
          const baselineWatermark = this.state.setIntakeBaseline(binding.channelId, watermark.last_seen_id, `${reason} empty channel baseline after live custody`, binding, ownedBoundary, ownedReadiness);
          if (!baselineWatermark) {
            const current = adoptCurrentReadiness();
            if (current?.state === READINESS.READY) continue;
            queueRecoveryIfPending();
            failure ||= { ready: false, state: current?.state || 'unavailable' };
            continue;
          }
          ownedBoundary = baselineWatermark;
        }
        watermark = this.state.getIntakeWatermark(binding.channelId);
      }
      let after = watermark?.recovered_through_id || null;
      let pages = 0;
      let total = 0;
      let complete = false;
      let attemptedId = null;
      try {
        while (pages < this.historyMaxPages && total < this.historyMaxMessages && Date.now() < deadline) {
          if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
          const options = { limit: this.historyPageLimit, signal };
          if (after) options.after = after;
          const page = this.historyMessages(await waitForRecoveryOperation(() => recoveryFetch(() => this.fetchHistory(channel, options)), signal, deadline));
          if (!currentRecovery()) throw recoveryError('stale', 'Discord recovery binding changed during history fetch');
          const fetchedBoundary = this.state.getIntakeWatermark(binding.channelId);
          if (fetchedBoundary?.state === READINESS.GAP || fetchedBoundary?.state === READINESS.UNAVAILABLE) {
            throw recoveryError('stale', 'Discord intake boundary changed during history fetch');
          }
          if (fetchedBoundary) ownedBoundary = fetchedBoundary;
          pages += 1;
          if (!page.length) { complete = true; break; }
          if (page.some(message => typeof message?.id !== 'string' || !message.id)) throw new Error('Discord history message has no stable ID');
          page.sort((a, b) => compareDiscordIds(a.id, b.id));
          const fresh = after ? page.filter(message => compareDiscordIds(message.id, after) > 0) : page;
          if (!fresh.length) { complete = true; break; }
          for (const message of fresh) {
            if (total >= this.historyMaxMessages) break;
            if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
            if (Date.now() >= deadline) throw recoveryError(CODEX_VALIDATION_KINDS.DEADLINE, 'Discord recovery deadline exceeded while admitting history');
            attemptedId = message.id;
            const admitted = await this.consumer.intakeMessage(this.normalizeFetchedMessage(message, channel), false, message.id, binding, false, signal, deadline, true);
            if (admitted?.stale) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
            if (!currentRecovery()) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
            const afterIntake = this.state.getIntakeWatermark(binding.channelId);
            if (afterIntake?.state === READINESS.GAP || afterIntake?.state === READINESS.UNAVAILABLE) {
              throw recoveryError('stale', 'Discord intake boundary changed during history intake');
            }
            if (afterIntake) ownedBoundary = afterIntake;
            total += 1;
            if (!after || compareDiscordIds(message.id, after) > 0) after = message.id;
          }
          if (total >= this.historyMaxMessages) break;
          if (fresh.length < page.length && page.length === this.historyPageLimit) {
            throw new Error('Discord history page overlapped the cursor without complete coverage');
          }
          if (page.length < this.historyPageLimit) { complete = true; break; }
        }
      } catch (error) {
        const kind = recoveryKind(error);
        if (kind === CODEX_VALIDATION_KINDS.STOPPED) return { ready: false, state: 'stopped' };
        if (kind === 'stale') {
          const current = adoptCurrentReadiness();
          if (current?.state === READINESS.READY) continue;
          if (current?.state === READINESS.PENDING) queueRecoveryIfPending();
          failure ||= { ready: false, state: current?.state || 'unavailable', error };
          continue;
        }
        const recorded = await recordOwnedBoundary(binding, channel, kind === CODEX_VALIDATION_KINDS.DEADLINE ? 'gap' : 'unavailable', error.message, ownedBoundary?.recovered_through_id, attemptedId || after, signal, deadline, ownedBoundary);
        if (recorded?.watermark) ownedBoundary = recorded.watermark;
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: kind === CODEX_VALIDATION_KINDS.DEADLINE ? 'gap' : 'unavailable', error };
        continue;
      }
      if (!complete) {
        const detail = pages >= this.historyMaxPages ? `history page bound ${this.historyMaxPages} reached` : total >= this.historyMaxMessages ? `history message bound ${this.historyMaxMessages} reached` : `history recovery deadline ${this.recoveryTimeoutMs}ms reached`;
        const recorded = await recordOwnedBoundary(binding, channel, 'gap', detail, ownedBoundary?.recovered_through_id, after, signal, deadline, ownedBoundary);
        if (recorded?.watermark) ownedBoundary = recorded.watermark;
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'gap' };
        continue;
      }
      const boundary = await recordOwnedBoundary(binding, channel, 'ready', `${reason} watermark backfill complete`, null, null, signal, deadline, ownedBoundary);
      if (!boundary || boundary.stale || boundary.blocked || (!boundary.concurrentReady && !currentRecovery())) {
        failure ||= { ready: false, state: 'unavailable' };
        continue;
      }
      const finalWatermark = this.state.getIntakeWatermark(binding.channelId);
      const finalBinding = this.state.getBinding(binding.channelId);
      const liveCustodyAhead = finalWatermark?.last_seen_id && (!finalWatermark.recovered_through_id || compareDiscordIds(finalWatermark.last_seen_id, finalWatermark.recovered_through_id) > 0);
      if (liveCustodyAhead || (finalBinding?.readiness !== READINESS.READY && finalBinding?.readiness !== READINESS.UNAVAILABLE)) {
        const detail = liveCustodyAhead
          ? 'live Discord custody arrived while recovery readiness was closing'
          : 'binding readiness changed while recovery readiness was closing';
        const recorded = await recordOwnedBoundary(binding, channel, 'gap', detail, finalWatermark?.recovered_through_id, finalWatermark?.last_seen_id, signal, deadline, finalWatermark);
        if (!recorded?.concurrentReady) failure ||= { ready: false, state: 'gap' };
      }
    }
    for (const enrollment of this.state.listThreadEnrollments()) {
      if (!enrollment.active || (selectedChannels && !selectedChannels.has(enrollment.parentChannelId) && !selectedChannels.has(enrollment.threadId))) continue;
      const recovered = await recoverThread(this, enrollment, signal, lifecycleEpoch, waitForRecoveryOperation, false, deadline);
      const currentEnrollment = this.state.getThreadEnrollment(enrollment.threadId);
      if (!recovered) {
        if (currentEnrollment?.active && currentEnrollment.state === THREAD_STATES.PENDING && !this.isPreAdoptionRetryableThread(enrollment.threadId)) {
          const currentCount = this.liveIntakeCounts.get(enrollment.threadId) || 0;
          this.liveIntakeCounts.set(enrollment.threadId, Math.max(currentCount, this.liveCheckpointThreshold));
        }
      }
    }
    return failure || { ready: true, state: 'ready' };
  }

  async recoverTransport(reason, lifecycleEpoch = this.lifecycleEpoch, channelIds = null, scopeRetryDepth = 0, recoveryDeadline = null) {
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
    const overallDeadline = recoveryDeadline ?? (Date.now() + this.recoveryTimeoutMs);
    const callerScope = channelIds === null || channelIds === undefined ? null : new Set(channelIds);
    const expandScope = scope => {
      if (scope === null) return null;
      const expanded = new Set(scope);
      for (const enrollment of this.state.listThreadEnrollments()) {
        if (!enrollment.active) continue;
        if (expanded.has(enrollment.parentChannelId) || expanded.has(enrollment.threadId)) expanded.add(enrollment.threadId);
      }
      return expanded;
    };
    const scopeIsReady = scope => {
      const expanded = expandScope(scope);
      const channelIds = expanded === null
        ? new Set(this.state.listBindings().filter(binding => binding.active).map(binding => binding.channelId))
        : expanded;
      for (const channelId of channelIds) {
        const binding = this.state.getBinding(channelId);
        const watermark = this.state.getIntakeWatermark(channelId);
        if (binding?.active && binding.readiness === READINESS.READY && watermark?.state === READINESS.READY) continue;
        const enrollment = this.state.getThreadEnrollment(channelId);
        if (enrollment?.active && enrollment.state === THREAD_STATES.READY) continue;
        return false;
      }
      if (expanded === null) {
        for (const enrollment of this.state.listThreadEnrollments()) {
          if (enrollment.active && enrollment.state !== THREAD_STATES.READY &&
              !this.isPreAdoptionRetryableThread(enrollment.threadId)) return false;
        }
      }
      return true;
    };
    const queuedFollowupScope = () => {
      if (this.pendingFullRecovery) return null;
      if (this.pendingRecoveryChannels.size) return new Set(this.pendingRecoveryChannels);
      if (this.recoveryFollowupScope instanceof Set) return this.recoveryFollowupScope;
      return null;
    };
    const followupIntersectsCaller = () => {
      const followupScope = queuedFollowupScope();
      if (callerScope === null || followupScope === null) return true;
      const callerChannels = expandScope(callerScope);
      const followupChannels = expandScope(followupScope);
      return [...callerChannels].some(channelId => followupChannels.has(channelId));
    };
    const resolveFollowup = async (initialResult, followupResult) => {
      if (!this.isCurrentLifecycle(lifecycleEpoch) || initialResult?.state === 'stopped' || followupResult?.state === 'stopped') {
        return { ready: false, state: 'stopped' };
      }
      if (callerScope === null) {
        if (initialResult && initialResult.ready !== true && scopeIsReady(null)) {
          return followupResult?.ready === true ? followupResult : { ready: true, state: 'ready' };
        }
        if (initialResult && initialResult.ready !== true && followupResult?.ready === true && scopeRetryDepth === 0) {
          return this.recoverTransport(reason, lifecycleEpoch, null, 1, overallDeadline);
        }
        if (initialResult && initialResult.ready !== true) return { ...followupResult, ...initialResult, ready: false };
        return followupResult || initialResult;
      }
      if (followupResult?.ready === true) {
        if (!initialResult || initialResult.ready === true || scopeIsReady(callerScope)) return followupResult;
        if (scopeRetryDepth === 0) return this.recoverTransport(reason, lifecycleEpoch, callerScope, 1, overallDeadline);
        return initialResult;
      }
      if (scopeIsReady(callerScope)) {
        return { ready: true, state: 'ready' };
      }
      if (scopeRetryDepth === 0) return this.recoverTransport(reason, lifecycleEpoch, callerScope, 1, overallDeadline);
      return followupResult || initialResult || { ready: false, state: 'unavailable' };
    };
    const fullRecovery = callerScope === null;
    if (fullRecovery) {
      this.ready = false;
      if (this.recoveryPromise) this.pendingFullRecovery = true;
    }
    if (channelIds) {
      for (const channelId of channelIds) {
        if (typeof channelId === 'string') this.pendingRecoveryChannels.add(channelId);
      }
    }
    if (this.recoveryPromise) {
      if (!this.pendingRecoveryChannels.size && !this.pendingFullRecovery) return this.recoveryPromise;
      if (!this.recoveryFollowupPromise) {
        const activeRecovery = this.recoveryPromise;
        this.recoveryFollowupPromise = activeRecovery.then(result => {
          this.recoveryFollowupPromise = null;
          this.recoveryFollowupScope = null;
          if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
          const runFullRecovery = this.pendingFullRecovery;
          const queuedChannels = new Set(this.pendingRecoveryChannels);
          this.pendingFullRecovery = false;
          this.pendingRecoveryChannels.clear();
          this.recoveryFollowupScope = runFullRecovery ? null : new Set(queuedChannels);
          if (runFullRecovery) return this.recoverTransport(reason, lifecycleEpoch, null, scopeRetryDepth + 1, overallDeadline);
          return queuedChannels.size ? this.recoverTransport(reason, lifecycleEpoch, queuedChannels, scopeRetryDepth + 1, overallDeadline) : result;
        }, error => {
          this.recoveryFollowupPromise = null;
          this.recoveryFollowupScope = null;
          throw error;
        });
      }
      if (!followupIntersectsCaller()) return this.recoveryPromise;
      const followupResult = await this.recoveryFollowupPromise;
      return resolveFollowup(null, followupResult);
    }
    const selectedChannels = this.pendingFullRecovery ? null :
      (this.pendingRecoveryChannels.size ? new Set(this.pendingRecoveryChannels) : callerScope);
    this.pendingFullRecovery = false;
    this.pendingRecoveryChannels.clear();
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    const activeRecovery = this.recoveryPromise = (async () => {
      const result = await this.recoverInbound(controller.signal, reason, lifecycleEpoch, selectedChannels, overallDeadline);
      const hasReadyBinding = this.state.listBindings().some(binding => binding.active && binding.readiness === READINESS.READY);
      if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      this.ready = result.ready || (result.state !== 'stopped' && hasReadyBinding);
      this.releaseRecoveredAttachmentIntake();
      return result;
    })();
    let result;
    try {
      result = await activeRecovery;
    } finally {
      if (this.recoveryPromise === activeRecovery) {
        this.recoveryPromise = null;
        this.recoveryController = null;
        this.releaseRecoveredAttachmentIntake();
        this.scheduleHeldLiveCheckpoints();
      }
    }
    const followup = this.recoveryFollowupPromise;
    if (!followup || !followupIntersectsCaller()) return result;
    const followupResult = await followup;
    return resolveFollowup(result, followupResult);
  }

  async reconcilePending(before = undefined, { allowPaused = false, readyOnly = false, channelIds = null } = {}) {
    const lifecycleEpoch = this.lifecycleEpoch;
    const connectionEpoch = this.connectionEpoch;
    while (this.recoveryPromise) {
      await this.recoveryPromise.catch(() => {});
      if (!this.isCurrentLifecycle(lifecycleEpoch) || connectionEpoch !== this.connectionEpoch) return [];
    }
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return [];
    const cutoff = before === undefined ? new Date().toISOString() : before;
    const hasReadyBinding = this.state.listBindings().some(binding => {
      return binding.active && binding.readiness === READINESS.READY;
    });
    if (!this.ready && !allowPaused && !hasReadyBinding) throw new Error('Discord gateway is not ready for recovery');
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    this.recoveryPromise = this._reconcilePending(cutoff, controller.signal, readyOnly || allowPaused, channelIds);
    try { return await this.recoveryPromise; }
    finally {
      this.recoveryPromise = null;
      this.recoveryController = null;
      this.scheduleHeldLiveCheckpoints();
    }
  }

  async _reconcilePending(before, signal, readyOnly = false, channelIds = null) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const selectedChannels = channelIds ? new Set(channelIds) : null;
    this.consumer?.releaseHandledWithoutPost?.();
    const allowed = message => (!selectedChannels || selectedChannels.has(message.channelId) || selectedChannels.has(message.deliveryChannelId)) &&
      (!readyOnly || this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready);
    this.startDecisionRecovery(signal, selectedChannels);
    const candidates = this.state.recoveryCandidates(before).filter(allowed);
    const ordered = candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const blockedOwners = new Set();
    for (const message of ordered) {
      if (signal?.aborted) return this.state.recoveryCandidates(before).filter(allowed);
      const key = `${message.provider}:${message.nativeId}`;
      if (blockedOwners.has(key)) continue;
      let channel;
      let channelFetchStarted = false;
      try {
        channel = await waitForRecoveryOperation(
          () => recoveryFetch(() => {
            channelFetchStarted = true;
            return this.client.channels.fetch(message.deliveryChannelId || message.channelId);
          }),
          signal,
          deadline
        );
      } catch (error) {
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) return this.state.recoveryCandidates(before).filter(allowed);
        blockedOwners.add(key);
        if (!channelFetchStarted) continue;
        this.markThreadDeliveryUnavailable(message, error);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (!channel) {
        blockedOwners.add(key);
        const error = new Error('Discord channel is unavailable during recovery');
        this.markThreadDeliveryUnavailable(message, error);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (message.deliveryChannelId && message.deliveryChannelId !== message.channelId) {
        try { assertPublicThread(channel, this.state.getBinding(message.channelId), message.deliveryChannelId, this.client.user); }
        catch (error) {
          this.markThreadDeliveryUnavailable(message, error);
          blockedOwners.add(key);
          continue;
        }
      }
      const storedMessage = {
        ...message,
        id: message.id,
        guildId: message.guildId,
        channelId: message.deliveryChannelId || message.channelId,
        content: message.content,
        author: { id: message.authorId, bot: false },
        channel
      };
      if (!this.state.getMessageRoute(message.deliveryChannelId || message.channelId)?.ready) {
        blockedOwners.add(key);
        continue;
      }
      let result;
      try {
        if (message.state === 'accepted') {
          result = await waitForRecoveryOperation(
            () => this.consumer.handleStoredMessage(storedMessage, signal, { continueUntilFinal: true, handoff: true, awaitDispatchOutcome: true }),
            signal,
            deadline
          );
        } else if (message.state === 'submitted') {
          result = await waitForRecoveryOperation(
            () => this.consumer.resumeSubmitted(storedMessage, signal, { continueUntilFinal: true }),
            signal,
            deadline
          );
        } else {
          this.state.recoverNativeReplyAcknowledgment(message.id);
          result = await this.consumer.deliverReply(storedMessage, { status: message.state, message }, signal);
        }
        if (result === DISPATCH_OUTCOMES.NOT_SUBMITTED || result?.status === DISPATCH_OUTCOMES.NOT_SUBMITTED) {
          blockedOwners.add(key);
        }
      } catch (error) {
        if (recoveryKind(error) === CODEX_VALIDATION_KINDS.STOPPED) return this.state.recoveryCandidates(before).filter(allowed);
        blockedOwners.add(key);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
    }
    return this.state.recoveryCandidates(before).filter(allowed);
  }

  startDecisionRecovery(signal, channelIds = null) {
    if (this.stopping || this.decisionRecoveryPromise || !this.decisionConsumer) return this.decisionRecoveryPromise;
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relayAbort, { once: true });
    this.decisionRecoveryController = controller;
    const work = Promise.resolve().then(() => this.decisionConsumer.recover(controller.signal, channelIds));
    const tracked = work.catch(error => {
      this.logger(`Discord decision recovery failed: ${error.message}`);
      return [];
    });
    this.decisionRecoveryPromise = tracked;
    this.inFlight.add(tracked);
    tracked.finally(() => {
      signal?.removeEventListener('abort', relayAbort);
      this.inFlight.delete(tracked);
      if (this.decisionRecoveryPromise === tracked) this.decisionRecoveryPromise = null;
      if (this.decisionRecoveryController === controller) this.decisionRecoveryController = null;
    }).catch(() => {});
    return tracked;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleEpoch += 1;
    this.connectionEpoch += 1;
    this.stopping = true;
    this.started = false;
    this.transportReady = false;
    this.resolveInteractionRecovery(false);
    for (const timer of this.liveAttachmentRecoveryTimers) clearImmediate(timer);
    this.liveAttachmentRecoveryTimers.clear();
    for (const channelId of this.attachmentIntakeBlockedChannels) this.consumer.releaseIntake(channelId);
    this.attachmentIntakeBlockedChannels.clear();
    this.attachmentIntakeRetryPendingChannels.clear();
    this.attachmentIntakeRetryMessages.clear();
    this.attachmentIntakeRetryInFlight.clear();
    if (this.deferredHandoffRecoveryTimer) clearTimeout(this.deferredHandoffRecoveryTimer);
    this.deferredHandoffRecoveryTimer = null;
    if (this.pendingHandoffRecoveryPollTimer) clearTimeout(this.pendingHandoffRecoveryPollTimer);
    this.pendingHandoffRecoveryPollTimer = null;
    this.deferredHandoffRecoveryChannels.clear();
    this.pendingHandoffRecoveryChannels.clear();
    this.pendingFullRecovery = false;
    this.pendingRecoveryChannels.clear();
    this.deferredHandoffRecoveryDelayMs = DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS;
    this.stopPromise = (async () => {
      this.ready = false;
      this.recoveryController?.abort();
      this.decisionRecoveryController?.abort();
      this.liveCheckpointController?.abort();
      const recovery = this.recoveryPromise;
      const reconnect = this.reconnectPromise;
      const liveCheckpoint = this.liveCheckpointPromise;
      await Promise.allSettled([recovery, reconnect, liveCheckpoint].filter(Boolean));
      if (this.liveCheckpointRetryTimer) clearTimeout(this.liveCheckpointRetryTimer);
      this.liveCheckpointRetryTimer = null;
      this.liveCheckpointRetryChannels = null;
      this.liveCheckpointRetryDelayMs = LIVE_CHECKPOINT_RETRY_INITIAL_DELAY_MS;
      this.liveIntakeCounts.clear();
      for (const controller of this.controllers) controller.abort();
      for (const controller of this.receiptControllers) controller.abort();
      const acknowledgmentStop = this.acknowledgments?.stop();
      this.acknowledgments = null;
      this.consumer.abortNativeWork();
      await Promise.allSettled([...this.inFlight]);
      await this.consumer.waitForNativeWork();
      await this.consumer.waitForReceipts();
      await acknowledgmentStop;
      this.client.off?.('messageCreate', this.boundMessage);
      this.client.off?.('interactionCreate', this.boundInteraction);
      this.client.off?.('shardResume', this.boundResume);
      this.client.off?.('resume', this.boundResume);
      this.client.off?.('shardDisconnect', this.boundDisconnect);
      this.client.off?.('shardReconnecting', this.boundReconnecting);
      this.client.off?.('shardReady', this.boundShardReady);
      try {
        if (typeof this.client.destroy === 'function') await this.client.destroy();
      } finally {
        this.discordToken = null;
      }
    })();
    try { await this.stopPromise; }
    finally {
      this.stopPromise = null;
      this.stopping = false;
    }
  }
}

module.exports = {
  DiscordGateway,
  classifyReplyError,
  createSurfaceConsumer,
  discordIdAfter,
  eventToInput,
  fetchAgentAttachment,
  fetchDiscordChannel,
  normalizeAgentMessage,
  readSecret,
  requireInstalled,
  sendDiscordMessage,
  waitForRecoveryOperation,
};
