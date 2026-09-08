const fs = require('node:fs');
const { ACK_WAITING, acknowledgmentCommand, createAcknowledgmentDelivery, waitForAcknowledgment, watchAcknowledgments } = require('./acknowledgment');
const { dispatchAndObserve, ClaudeProvider, CodexProvider, observeSubmitted, probeClaudeChannel, validateCodexSessionIdentity, validateCodexSessionIdentityAsync, waitForReply } = require('./native');
const { MESSAGE_STATES, READINESS, RECOVERY_LIMITS, UnresolvedWorkError } = require('./state');
const { conductorMarkerMatches } = require('./topic');

const requireInstalled = require;

function recoveryError(kind, detail) {
  const error = new Error(detail);
  error.recoveryKind = kind;
  return error;
}

function waitForRecoveryOperation(operation, signal, deadline, onDeadline = null) {
  if (signal?.aborted) return Promise.reject(recoveryError('stopped', 'Discord recovery was stopped'));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(recoveryError('deadline', 'Discord recovery deadline exceeded'));
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
    const onAbort = () => finish(reject, recoveryError('stopped', 'Discord recovery was stopped'));
    timer = setTimeout(() => {
      try { onDeadline?.(); } finally { finish(reject, recoveryError('deadline', 'Discord recovery deadline exceeded')); }
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

function compareDiscordIds(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a > b ? 1 : -1;
  } catch {
    return String(left).localeCompare(String(right));
  }
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
  if (error?.status === 400 || error?.status === 401 || error?.status === 403 || error?.status === 404 || error?.code === 50013) return 'failed';
  if (error?.status >= 500 || error?.potentiallyDelivered || error?.wrote || error?.name === 'TypeError') return 'unknown';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)) return 'unknown';
  return 'unknown';
}

function classifyTransportReceiptError(error) {
  if (error?.status === 429 || error?.code === 429 || /^RateLimitError(?:\[|$)/.test(String(error?.name || '')) || /^RateLimitError(?:\[|$)/.test(String(error?.message || ''))) return 'rate_limited';
  if ([400, 401, 403, 404].includes(error?.status) || error?.code === 50013) return 'rejected';
  return 'unknown';
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {}
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
  fetchImpl = globalThis.fetch, messageReference = null, allowedMentions = { parse: [] } }) {
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('Discord message fetch is unavailable'), { outcome: 'not_sent' });
  if (signal?.aborted) throw Object.assign(new Error('Discord message send stopped before request'), { outcome: 'not_sent' });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  let started = false;
  const operation = (async () => {
    started = true;
    let response;
    try {
      response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'DiscordBot (discord-surface, 0.1.0)',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          content, nonce, enforce_nonce: true, allowed_mentions: allowedMentions,
          ...(messageReference ? { message_reference: messageReference } : {})
        }),
        signal: controller.signal
      });
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

function transportReceiptText(message, attempt) {
  if (attempt.readiness === 'ready') return 'Receipt: saved for this conductor.';
  return 'Receipt: saved. Delivery was paused when this receipt was prepared.';
}

function createSurfaceConsumer({ state, providers, sendReply, sendTransportReceipt, prepareReply, trackReceipt, observeOptions = {} }) {
  const receiptWork = new Set();
  const nativeWork = new Map();
  const ownerQueues = new Map();
  const queuedNativeWork = new Map();
  let queueSequence = 0;

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
      nonce: authorized.nonce,
      enforceNonce: true,
      allowedMentions: { parse: [], repliedUser: false },
      reply: { messageReference: message.id, failIfNotExists: false }
    };
    const sender = sendTransportReceipt || ((source, receipt) => source.channel?.send(receipt));
    try {
      const sent = await sender(message, payload);
      const receiptMessageId = sent?.id || sent?.messageId;
      if (!receiptMessageId) throw new Error('Discord did not return a transport receipt message id');
      return state.recordTransportReceiptOutcome(message.id, 'sent', { receiptMessageId });
    } catch (error) {
      return state.recordTransportReceiptOutcome(message.id, classifyTransportReceiptError(error), { error: String(error?.message || error).slice(0, 200) });
    }
  }

  function launchTransportReceipt(message) {
    return trackReceiptWork(issueTransportReceipt(message));
  }

  function nativeOwnerKey(message) {
    const durable = message.provider && message.nativeId ? message : state.getMessage(message.id) || message;
    return `${durable.provider}:${durable.nativeId}`;
  }

  function hasCurrentNativeAcknowledgment(message) {
    if (!message || !state.hasNativeAcknowledgment(message)) return false;
    return state.currentMessageBinding(message).current;
  }

  function ownerCanAdvance(messageId) {
    const message = state.getMessage(messageId);
    return !message || [MESSAGE_STATES.ACCEPTED, MESSAGE_STATES.REPLY_READY, MESSAGE_STATES.REPLIED, MESSAGE_STATES.REPLY_FAILED, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state) ||
      (message.state === MESSAGE_STATES.SUBMITTED && hasCurrentNativeAcknowledgment(message));
  }

  function ownerBindingReady(messageId) {
    const message = state.getMessage(messageId);
    if (!message) return true;
    const binding = state.getBinding(message.channelId);
    return !binding || !binding.active || binding.readiness === READINESS.READY;
  }

  function ownerQueueFor(key) {
    let queue = ownerQueues.get(key);
    if (!queue) {
      queue = { active: null, blockedMessageId: null, blockedReason: null, entries: [] };
      ownerQueues.set(key, queue);
    }
    return queue;
  }

  function blockingEarlierOwnerMessage(message) {
    const messages = state.listMessages();
    const currentIndex = messages.findIndex(candidate => candidate.id === message.id);
    if (currentIndex < 0) return null;
    return messages.slice(0, currentIndex).find(candidate => nativeOwnerKey(candidate) === nativeOwnerKey(message) &&
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
      finishOwner(active);
      return queue.active !== active;
    }
    if (queue.blockedMessageId !== messageId) return false;
    queue.blockedMessageId = null;
    queue.blockedReason = null;
    pumpOwner(nativeOwnerKey(message));
    return true;
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
    if (queue.blockedMessageId && ownerCanAdvance(queue.blockedMessageId) &&
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
      sequence: queueSequence++,
      started: false,
      cancelled: false,
      dispatchBlocked: false,
      onAbort: null
    };
    if (!queue.active && queue.blockedMessageId === message.id) {
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
    queue.entries.sort((left, right) => left.queueMessage.createdAt.localeCompare(right.queueMessage.createdAt) || left.sequence - right.sequence);
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

  function processAccepted(message, signal, { continueUntilFinal = true, awaitExisting = true, handoff = false, awaitDispatchOutcome = false } = {}) {
    const existing = existingNativeWork(message, awaitExisting);
    if (existing) return existing;
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
            onDispatchOutcome: outcome => {
              if (outcome?.status === 'not_submitted') ownerEntry.dispatchBlocked = true;
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

  async function handleMessage(message, signal) {
    const intake = state.acceptDiscordMessage(eventToInput(message));
    if (!intake.accepted) return intake;
    launchTransportReceipt(message);
    return processAccepted(message, signal);
  }

  async function intakeMessage(message, ready = false, coverageId = null, expectedBinding = null, emitReceipt = false) {
    const intake = await state.acceptDiscordMessage(eventToInput(message), { ready, coverageId, expectedBinding });
    if (emitReceipt && intake.accepted) launchTransportReceipt(message);
    return intake;
  }

  async function handleStoredMessage(message, signal, { continueUntilFinal = false, handoff = false, awaitDispatchOutcome = false } = {}) {
    launchTransportReceipt(message);
    return processAccepted(message, signal, { continueUntilFinal, awaitExisting: false, handoff, awaitDispatchOutcome });
  }

  function resumeSubmitted(message, signal, { awaitExisting = false, continueUntilFinal = false } = {}) {
    launchTransportReceipt(message);
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

  return { abortNativeWork, deliverReply, handleMessage, handleStoredMessage, intakeMessage, issueTransportReceipt, processAccepted, releaseAcknowledged, resumeSubmitted, waitForNativeWork, waitForReceipts };
}

class DiscordGateway {
  constructor({ state, client, logger = () => {}, observeOptions = {}, providers, fetchHistory, recoveryOptions = {} } = {}) {
    this.state = state;
    this.logger = logger;
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
    this.reconnectPromise = null;
    this.fetchHistoryInjected = typeof fetchHistory === 'function';
    this.fetchHistory = fetchHistory || ((channel, options) => channel.messages?.fetch(options));
    this.historyPageLimit = Math.min(RECOVERY_LIMITS.pageSize, Math.max(1, Number(recoveryOptions.pageLimit || RECOVERY_LIMITS.pageSize)));
    this.historyMaxPages = Math.min(RECOVERY_LIMITS.maxPages, Math.max(1, Number(recoveryOptions.maxPages || RECOVERY_LIMITS.maxPages)));
    this.historyMaxMessages = Math.min(RECOVERY_LIMITS.maxMessages, Math.max(1, Number(recoveryOptions.maxMessages || RECOVERY_LIMITS.maxMessages)));
    this.recoveryTimeoutMs = Math.min(RECOVERY_LIMITS.timeoutMs, Math.max(1000, Number(recoveryOptions.timeoutMs || RECOVERY_LIMITS.timeoutMs)));
    this.codexSessionRoot = recoveryOptions.codexSessionRoot;
    this.ready = false;
    this.deliverAcknowledgment = createAcknowledgmentDelivery({
      state,
      send: (message, reaction) => this.sendAcknowledgment(message, reaction)
    });
    this.providers = providers || {
      codex: new CodexProvider({ acknowledgmentFor: message => acknowledgmentCommand(message, state.dbPath) }),
      claude: new ClaudeProvider({ waitForReply: (id, options) => waitForReply(state, id, options) })
    };
    this.ordinaryNativePreflight = recoveryOptions.ordinaryNativePreflight || (async binding => {
      if (binding.provider === 'codex') return validateCodexSessionIdentityAsync(binding.nativeId, binding.workspace, binding.sessionRoot || this.codexSessionRoot);
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
      providers: this.providers,
      sendReply: (message, reply) => this.sendReply(message, reply),
      prepareReply: (messageId, signal) => this.prepareReply(messageId, signal),
      sendTransportReceipt: (message, receipt) => this.sendTransportReceipt(message, receipt),
      observeOptions: {
        ...observeOptions,
        onNativeUnavailable: (message, error, outcome) => {
          try { onNativeUnavailable?.(message, error, outcome); } catch {}
          this.handleNativeUnavailable(message, error, outcome);
        }
      }
    });
    this.boundMessage = message => {
      if (this.stopping) return;
      const controller = new AbortController();
      this.controllers.add(controller);
      const binding = message?.channelId ? this.state.getBinding(message.channelId) : null;
      const bindingReady = binding?.active === true && binding.readiness === READINESS.READY;
      const dispatchReady = bindingReady && (this.ready || (this.started && !this.starting));
      const work = (dispatchReady ? this.consumer.handleMessage(message, controller.signal) : this.consumer.intakeMessage(message, false, null, null, true))
        .catch(error => this.logger(`message handling failed: ${error.message}`))
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
    this.client.on?.('shardResume', this.boundResume);
    this.client.on?.('resume', this.boundResume);
    this.client.on?.('shardDisconnect', this.boundDisconnect);
    this.client.on?.('shardReconnecting', this.boundReconnecting);
    this.client.on?.('shardReady', this.boundShardReady);
  }

  createClient() {
    const { Client, GatewayIntentBits } = requireInstalled('discord.js');
    return new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  }

  async sendReply(message, reply) {
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    if (typeof reply.replyText !== 'string' || reply.replyText.length > 2000) throw new Error('Discord reply must be at most 2000 characters per message');
    if (typeof reply.replyNonce !== 'string' || reply.replyNonce.length > 25) throw new Error('Discord reply nonce must be at most 25 characters');
    const channel = message.channel || await this.client.channels?.fetch?.(message.channelId);
    if (!channel?.send) throw new Error('Discord reply channel is unavailable');
    this.state.assertMessageCurrent(reply.id, 'reply-send');
    try {
      return await channel.send({
        content: reply.replyText,
        nonce: reply.replyNonce,
        enforceNonce: true,
        allowedMentions: { parse: [] }
      });
    } catch (error) {
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
    let source = message;
    if (!source.channel && !(this.discordToken && this.client?.rest)) {
      const channel = await this.client.channels?.fetch?.(message.channelId);
      if (!channel) throw new Error('Discord acknowledgment channel is unavailable');
      source = { ...message, channel };
    }
    this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
    return this.sendTransportReceipt(source, { reaction });
  }

  async sendTransportReceipt(message, receipt) {
    const controller = new AbortController();
    this.receiptControllers.add(controller);
    try {
      let sendPromise;
      try {
        // discord.js channel.send drops the signal and uses the shared REST retry queue.
        if (this.discordToken && this.client?.rest && typeof globalThis.fetch === 'function') {
          if (receipt.reaction) {
            const channelId = message.channelId || message.channel.id;
            const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(message.id)}/reactions/${encodeURIComponent(receipt.reaction)}/@me`;
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
              return { id: message.id, reaction: receipt.reaction };
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
            const source = await message.channel.messages.fetch(message.id);
            this.state.assertMessageCurrent(message.id, 'native-ack-reaction');
            return source.react(receipt.reaction);
          };
          sendPromise = receipt.reaction
            ? Promise.resolve(message.react ? message.react(receipt.reaction) : reactToFetchedMessage())
              .then(() => ({ id: message.id, reaction: receipt.reaction }))
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

  pauseConnection(detail) {
    if (this.stopping) return;
    this.ready = false;
    this.connectionEpoch += 1;
    this.recoveryController?.abort();
    for (const binding of this.state.listBindings().filter(item => item.active)) {
      try { this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, detail, binding); }
      catch (error) { this.logger(`Discord disconnect readiness update failed: ${error.message}`); }
    }
  }

  beginReconnectRecovery(reason) {
    if (this.stopping) return Promise.resolve({ ready: false, state: 'stopped' });
    const connectionEpoch = this.connectionEpoch;
    const lifecycleEpoch = this.lifecycleEpoch;
    const previousRecovery = this.recoveryPromise;
    const task = (async () => {
      await previousRecovery?.catch(() => {});
      if (this.stopping || connectionEpoch !== this.connectionEpoch) return { ready: false, state: 'stopped' };
      const result = await this.recoverTransport('reconnect', lifecycleEpoch);
      if (this.isCurrentLifecycle(lifecycleEpoch) && connectionEpoch === this.connectionEpoch && result.state !== 'stopped') {
        await this.reconcilePending();
      }
      return result;
    })().catch(error => {
      this.logger(`Discord recovery failed: ${error.message}`);
      return { ready: false, state: recoveryKind(error) || 'unavailable', error };
    });
    this.reconnectPromise = task;
    task.finally(() => {
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
    const startPromise = (async () => {
      const token = readSecret(secretFile);
      this.discordToken = token;
      await this.client.login(token);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError('stopped', 'Discord startup was stopped during login');
      const recovery = await this.recoverTransport('startup', epoch);
      if (!this.isCurrentLifecycle(epoch)) throw recoveryError('stopped', 'Discord startup was stopped during recovery');
      if (!recovery.ready) throw new Error(`Discord intake recovery is ${recovery.state}`);
      this.started = true;
      this.acknowledgments = watchAcknowledgments({
        state: this.state,
        send: (message, reaction) => this.sendAcknowledgment(message, reaction),
        deliver: this.deliverAcknowledgment,
        onAcknowledged: messageId => {
          if (this.stopping) return null;
          const message = this.state.getMessage(messageId);
          if (![MESSAGE_STATES.SUBMITTED, MESSAGE_STATES.REPLY_READY].includes(message?.state)) return null;
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
    if (!this.client.user || typeof channel?.permissionsFor !== 'function') return { known: false, allowed: false };
    try {
      const { PermissionFlagsBits } = requireInstalled('discord.js');
      const permissions = channel.permissionsFor(this.client.user);
      if (!permissions || typeof permissions.has !== 'function') return { known: false, allowed: false };
      const historyAllowed = permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.ReadMessageHistory);
      const replyPermission = typeof channel.isThread === 'function' && channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
      const threadStateBlocksSend = typeof channel.isThread === 'function' && channel.isThread() &&
        channel.locked === true;
      const sendAllowed = !requireSend || (replyPermission !== undefined && permissions.has(replyPermission) && !threadStateBlocksSend);
      return {
        known: true,
        allowed: historyAllowed && sendAllowed
      };
    } catch {
      return { known: false, allowed: false };
    }
  }

  async recordBoundary(binding, channel, state, detail, gapFrom = null, gapTo = null, signal = null) {
    if (signal?.aborted || !this.isCurrentBinding(binding)) return null;
    let watermark;
    try {
      watermark = this.state.markIntakeBoundary(binding.channelId, state, detail, gapFrom, gapTo, binding);
    } catch (error) {
      if (!(error instanceof UnresolvedWorkError) || state !== 'ready') throw error;
      const blockedDetail = `${detail}; legacy topic migration custody is unresolved`;
      watermark = this.state.markIntakeBoundary(binding.channelId, READINESS.UNAVAILABLE, blockedDetail, gapFrom, gapTo, binding);
      return watermark ? { watermark, topicPublished: false, publication: null, blocked: true, error } : null;
    }
    if (!watermark) return null;
    return { watermark, topicPublished: true, publication: null };
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
    const detail = `Claude endpoint unavailable before event write: ${String(error?.message || error || 'unknown error').slice(0, 900)}`;
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

  async verifyOrdinaryNative(binding) {
    if (!this.state.isOrdinaryBinding?.(binding)) return null;
    if (!this.providers[binding.provider] || typeof this.providers[binding.provider].dispatch !== 'function') {
      throw new Error(`${binding.provider} delivery provider is unavailable for ordinary binding`);
    }
    const proof = await this.ordinaryNativePreflight(binding);
    if (!proof || typeof proof !== 'object') throw new Error(`${binding.provider} native preflight returned no proof`);
    if (!this.isCurrentBinding(binding)) throw recoveryError('stale', `ordinary ${binding.provider} binding changed during native preflight`);
    const recorded = this.state.recordOrdinaryPreflight(binding, proof);
    if (!recorded) throw recoveryError('stale', `ordinary ${binding.provider} binding changed before native preflight was recorded`);
    return proof;
  }

  async recoverInbound(signal, reason, lifecycleEpoch = this.lifecycleEpoch) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const bindings = this.state.listBindings().filter(binding => binding.active);
    let failure = null;
    for (const binding of bindings) {
      if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      if (Date.now() >= deadline) {
        await this.recordBoundary(binding, null, 'gap', `${reason} recovery exceeded ${this.recoveryTimeoutMs}ms`, null, null, signal, deadline);
        failure ||= { ready: false, state: 'gap' };
        continue;
      }
      const recovering = this.state.setBindingReadiness(binding.channelId, READINESS.RECOVERING, `${reason} intake recovery in progress`, binding);
      if (!recovering) {
        failure ||= { ready: false, state: 'unavailable' };
        continue;
      }
      let watermark = this.state.getIntakeWatermark(binding.channelId);
      if (watermark && ['gap', 'unavailable'].includes(watermark.state)) {
        const terminalReadiness = watermark.state === READINESS.GAP ? READINESS.GAP : READINESS.UNAVAILABLE;
        this.state.setBindingReadiness(binding.channelId, terminalReadiness,
          watermark.detail || `${reason} intake ${watermark.state}`, binding);
        failure ||= { ready: false, state: watermark.state };
        continue;
      }
      let channel;
      try {
        channel = await waitForRecoveryOperation(() => this.client.channels.fetch(binding.channelId), signal, deadline);
        if (!channel) throw new Error('Discord channel is unavailable');
      } catch (error) {
        const kind = recoveryKind(error);
        if (kind === 'stopped') return { ready: false, state: 'stopped' };
        await this.recordBoundary(binding, null, kind === 'deadline' ? 'gap' : 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
        continue;
      }
      if (!this.isCurrentBinding(binding)) {
        failure ||= { ready: false, state: 'unavailable' };
        continue;
      }
      const ordinary = this.state.isOrdinaryBinding?.(binding);
      if (ordinary && channel.guildId && channel.guildId !== binding.guildId) {
        const error = new Error('Discord channel is outside the configured guild');
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (ordinary) {
        try {
          await waitForRecoveryOperation(() => this.verifyOrdinaryNative(binding), signal, deadline);
        } catch (error) {
          const kind = recoveryKind(error);
          if (kind === 'stopped') return { ready: false, state: 'stopped' };
          if (kind === 'stale') {
            failure ||= { ready: false, state: 'unavailable', error };
            continue;
          }
          const detail = binding.provider === 'claude' && ['Claude endpoint unavailable', 'ordinary-bind', 'reconnect', 'startup'].includes(reason)
            ? `Claude endpoint unavailable before event write: ${error.message}`
            : error.message;
          await this.recordBoundary(binding, channel, kind === 'deadline' ? 'gap' : 'unavailable', detail, watermark?.recovered_through_id, null, signal, deadline);
          failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
          continue;
        }
      }
      if (!ordinary && !conductorMarkerMatchesTopic(channel.topic, binding)) {
        const error = new Error('Discord channel topic does not identify the current conductor and native generation');
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!this.fetchHistoryInjected && typeof channel.messages?.fetch !== 'function') {
        const error = new Error('Discord history fetch is unavailable for intake recovery');
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      const permission = this.historyPermission(channel, { requireSend: ordinary });
      if (!permission.known || !permission.allowed) {
        let detail = 'Discord channel history permission is unknown';
        if (permission.known && ordinary) detail = 'Discord channel lacks history or reply permission';
        else if (permission.known) detail = 'Discord channel lacks ViewChannel or ReadMessageHistory';
        const error = new Error(detail);
        await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
        failure ||= { ready: false, state: 'unavailable', error };
        continue;
      }
      if (!watermark?.recovered_through_id) {
        let baseline;
        try { baseline = this.historyMessages(await waitForRecoveryOperation(() => this.fetchHistory(channel, { limit: 1, signal }), signal, deadline)); }
        catch (error) {
          const kind = recoveryKind(error);
          if (kind === 'stopped') return { ready: false, state: 'stopped' };
          await this.recordBoundary(binding, channel, kind === 'deadline' ? 'gap' : 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
          failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
          continue;
        }
        if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
        if (!this.isCurrentBinding(binding)) {
          failure ||= { ready: false, state: 'unavailable' };
          continue;
        }
        if (baseline.some(message => typeof message?.id !== 'string' || !message.id)) {
          const error = new Error('Discord history message has no stable ID');
          await this.recordBoundary(binding, channel, 'unavailable', error.message, watermark?.recovered_through_id, null, signal, deadline);
          failure ||= { ready: false, state: 'unavailable', error };
          continue;
        }
        const newest = baseline.sort((a, b) => compareDiscordIds(b.id, a.id))[0];
        if (newest?.id) {
          const baseline = this.state.setIntakeBaseline(binding.channelId, newest.id, `${reason} cutoff excludes pre-adoption backlog`, binding);
          if (!baseline) {
            failure ||= { ready: false, state: 'unavailable' };
            continue;
          }
        } else {
          watermark = this.state.getIntakeWatermark(binding.channelId);
          if (!watermark?.last_seen_id) {
            const boundary = await this.recordBoundary(binding, channel, 'ready', `${reason} empty channel baseline`, null, null, signal, deadline);
            if (!boundary || boundary.stale || boundary.blocked) failure ||= { ready: false, state: 'unavailable', error: boundary?.error };
            continue;
          }
          const baseline = this.state.setIntakeBaseline(binding.channelId, watermark.last_seen_id, `${reason} empty channel baseline after live custody`, binding);
          if (!baseline) {
            failure ||= { ready: false, state: 'unavailable' };
            continue;
          }
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
          const page = this.historyMessages(await waitForRecoveryOperation(() => this.fetchHistory(channel, options), signal, deadline));
          if (!this.isCurrentBinding(binding)) throw recoveryError('stale', 'Discord recovery binding changed during history fetch');
          pages += 1;
          if (!page.length) { complete = true; break; }
          if (page.some(message => typeof message?.id !== 'string' || !message.id)) throw new Error('Discord history message has no stable ID');
          page.sort((a, b) => compareDiscordIds(a.id, b.id));
          const fresh = after ? page.filter(message => compareDiscordIds(message.id, after) > 0) : page;
          if (!fresh.length) { complete = true; break; }
          for (const message of fresh) {
            if (total >= this.historyMaxMessages) break;
            if (signal.aborted || !this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
            if (Date.now() >= deadline) throw recoveryError('deadline', 'Discord recovery deadline exceeded while admitting history');
            attemptedId = message.id;
            const admitted = await this.consumer.intakeMessage(this.normalizeFetchedMessage(message, channel), false, message.id, binding);
            if (admitted?.stale) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
            if (!this.isCurrentBinding(binding)) throw recoveryError('stale', 'Discord recovery binding changed during history intake');
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
        if (kind === 'stopped') return { ready: false, state: 'stopped' };
        if (kind === 'stale') {
          failure ||= { ready: false, state: 'unavailable', error };
          continue;
        }
        await this.recordBoundary(binding, channel, kind === 'deadline' ? 'gap' : 'unavailable', error.message, watermark?.recovered_through_id, attemptedId || after, signal, deadline);
        failure ||= { ready: false, state: kind === 'deadline' ? 'gap' : 'unavailable', error };
        continue;
      }
      if (!complete) {
        const detail = pages >= this.historyMaxPages ? `history page bound ${this.historyMaxPages} reached` : total >= this.historyMaxMessages ? `history message bound ${this.historyMaxMessages} reached` : `history recovery deadline ${this.recoveryTimeoutMs}ms reached`;
        await this.recordBoundary(binding, channel, 'gap', detail, watermark?.recovered_through_id, after, signal, deadline);
        failure ||= { ready: false, state: 'gap' };
        continue;
      }
      const boundary = await this.recordBoundary(binding, channel, 'ready', `${reason} watermark backfill complete`, null, null, signal, deadline);
      if (!boundary || boundary.stale || boundary.blocked || !this.isCurrentBinding(binding)) {
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
        await this.recordBoundary(binding, channel, 'gap', detail, finalWatermark?.recovered_through_id, finalWatermark?.last_seen_id, signal, deadline);
        failure ||= { ready: false, state: 'gap' };
      }
    }
    return failure || { ready: true, state: 'ready' };
  }

  async recoverTransport(reason, lifecycleEpoch = this.lifecycleEpoch) {
    if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
    this.ready = false;
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    this.recoveryPromise = (async () => {
      const result = await this.recoverInbound(controller.signal, reason, lifecycleEpoch);
      if (result.ready && this.isCurrentLifecycle(lifecycleEpoch)) this.ready = true;
      else if (!this.isCurrentLifecycle(lifecycleEpoch)) return { ready: false, state: 'stopped' };
      else this.ready = false;
      return result;
    })();
    try { return await this.recoveryPromise; }
    finally {
      this.recoveryPromise = null;
      this.recoveryController = null;
    }
  }

  async reconcilePending(before = new Date().toISOString()) {
    const hasReadyBinding = this.state.listBindings().some(binding => {
      return binding.active && binding.readiness === READINESS.READY;
    });
    if (!this.ready && !hasReadyBinding) throw new Error('Discord gateway is not ready for recovery');
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryController = new AbortController();
    const controller = this.recoveryController;
    this.recoveryPromise = this._reconcilePending(before, controller.signal);
    try { return await this.recoveryPromise; }
    finally {
      this.recoveryPromise = null;
      this.recoveryController = null;
    }
  }

  async _reconcilePending(before, signal) {
    const deadline = Date.now() + this.recoveryTimeoutMs;
    const candidates = this.state.recoveryCandidates(before).filter(message => {
      return this.state.getBinding(message.channelId)?.readiness === READINESS.READY;
    });
    const ordered = candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const blockedOwners = new Set();
    for (const message of ordered) {
      if (signal?.aborted) return this.state.recoveryCandidates(before);
      const key = `${message.provider}:${message.nativeId}`;
      if (blockedOwners.has(key)) continue;
      let channel;
      try { channel = await waitForRecoveryOperation(() => this.client.channels.fetch(message.channelId), signal, deadline); } catch (error) {
        if (recoveryKind(error) === 'stopped') return this.state.recoveryCandidates(before);
        blockedOwners.add(key);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
      if (!channel) {
        blockedOwners.add(key);
        this.state.markObservationUnavailable(message.id, new Error('Discord channel is unavailable during recovery'));
        continue;
      }
      const storedMessage = {
        ...message,
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        content: message.content,
        author: { id: message.authorId, bot: false },
        channel
      };
      if (this.state.getBinding(message.channelId)?.readiness !== READINESS.READY) {
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
        if (result === 'not_submitted' || result?.state === 'not_submitted' || result?.status === 'not_submitted') {
          blockedOwners.add(key);
        }
      } catch (error) {
        if (recoveryKind(error) === 'stopped') return this.state.recoveryCandidates(before);
        blockedOwners.add(key);
        this.state.markObservationUnavailable(message.id, error);
        continue;
      }
    }
    return this.state.recoveryCandidates(before);
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.lifecycleEpoch += 1;
    this.connectionEpoch += 1;
    this.stopping = true;
    this.started = false;
    this.stopPromise = (async () => {
      this.ready = false;
      this.recoveryController?.abort();
      const recovery = this.recoveryPromise;
      const reconnect = this.reconnectPromise;
      await Promise.allSettled([recovery, reconnect].filter(Boolean));
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
  eventToInput,
  readSecret,
  requireInstalled,
  sendDiscordMessage,
};
