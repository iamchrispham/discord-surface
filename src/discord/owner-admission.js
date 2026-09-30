const { MESSAGE_STATES, READINESS } = require('../state');

function isDiscordId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function sameNativeOwner(left, right) {
  return left.provider === right.provider && left.nativeId === right.nativeId;
}

function createOwnerAdmission({ state, compareDiscordIds }) {
  const nativeWork = new Map();
  const ownerQueues = new Map();
  const queuedNativeWork = new Map();
  let queueSequence = 0;

  function compareRecoveryCandidates(left, right) {
    if (sameNativeOwner(left, right) && isDiscordId(left.id) && isDiscordId(right.id)) {
      const byDiscordId = compareDiscordIds(left.id, right.id);
      if (byDiscordId !== 0) return byDiscordId;
    }
    return left.createdAt.localeCompare(right.createdAt);
  }

  function nativeOwnerKey(message) {
    const durable = message.provider && message.nativeId ? message : state.getMessage(message.id) || message;
    return `${durable.provider}:${durable.nativeId}`;
  }

  function hasCurrentNativeAcknowledgment(message) {
    if (!message || !state.hasNativeAcknowledgment(message)) return false;
    return state.currentMessageBinding(message).current;
  }

  function courierCustodyRequiresOwnerHold(messageId) {
    const latest = state.getMessage(messageId);
    const attempt = state.getCourierAttempt?.(messageId);
    return Boolean(latest && latest.state === MESSAGE_STATES.ACCEPTED &&
      !hasCurrentNativeAcknowledgment(latest) && attempt &&
      (state.hasCourierForwardClaim?.(messageId) ||
        !state.hasRetiredCourierAttempt?.(messageId, attempt.attempt.receiptId)));
  }

  function retiredCourierCustodyHeld(messageId) {
    const latest = state.getMessage(messageId);
    const attempt = state.getCourierAttempt?.(messageId);
    return Boolean(latest && latest.state === MESSAGE_STATES.ACCEPTED &&
      !hasCurrentNativeAcknowledgment(latest) && attempt &&
      !state.hasCourierForwardClaim?.(messageId) &&
      state.hasRetiredCourierAttempt?.(messageId, attempt.attempt.receiptId));
  }

  function refreshCourierCustodyBlock(messageId, ownerEntry) {
    if (ownerEntry.dispatchBlocked || !courierCustodyRequiresOwnerHold(messageId)) return;
    ownerEntry.dispatchBlocked = true;
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
    if (entry.dispatchBlocked || retiredCourierCustodyHeld(entry.message.id)) {
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

  function trackNativeWork(message, work, onSettled = null) {
    const tracked = Promise.resolve(work);
    const messageId = message.id;
    // F11: retain the ORIGINAL message reference so a later verified channel fetch can
    // refresh only this entry's delivery channel without replacing the promise/observer.
    nativeWork.set(messageId, { message, promise: tracked, controller: null });
    tracked.finally(() => {
      if (nativeWork.get(messageId)?.promise !== tracked) return;
      nativeWork.delete(messageId);
      try { onSettled?.(messageId); } catch {}
    }).catch(() => {});
    return tracked;
  }

  function startNativeWork(message, signal, workFactory, onSettled = null) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) return { status: 'stopped', message: null };
      return workFactory(controller.signal);
    });
    const tracked = trackNativeWork(message, work, onSettled);
    const entry = nativeWork.get(message.id);
    if (entry?.promise === tracked) entry.controller = controller;
    tracked.finally(() => signal?.removeEventListener('abort', onAbort)).catch(() => {});
    return tracked;
  }

  // F11: a later verified channel fetch refreshes ONLY the existing entry's delivery
  // channel. A channel-less input never clears usable channel context, and the object,
  // promise and observer remain the same.
  function refreshNativeWorkChannel(message) {
    const channel = message?.channel;
    if (!channel) return false;
    let refreshed = false;
    const active = nativeWork.get(message.id);
    if (active?.message) { active.message.channel = channel; refreshed = true; }
    const queued = queuedNativeWork.get(message.id);
    if (queued?.message) { queued.message.channel = channel; refreshed = true; }
    return refreshed;
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

  function retryRetiredCourierWork(message, signal, options, startAccepted) {
    const ownerKey = nativeOwnerKey(message);
    const old = nativeWork.get(message.id);
    const queue = ownerQueues.get(ownerKey);
    if (old?.controller && queue && retiredCourierCustodyHeld(message.id)) {
      old.controller.abort();
      return old.promise.then(
        result => result?.error || signal?.aborted || ownerQueues.get(ownerKey) !== queue || !retiredCourierCustodyHeld(message.id)
          ? { status: 'stopped', message: state.getMessage(message.id) }
          : startAccepted(message, signal, options),
        () => ({ status: 'stopped', message: state.getMessage(message.id) })
      );
    }
    return startAccepted(message, signal, options);
  }

  return {
    abortNativeWork,
    courierCustodyRequiresOwnerHold,
    enqueueOwnerWork,
    existingNativeWork,
    hasCurrentNativeAcknowledgment,
    refreshCourierCustodyBlock,
    refreshNativeWorkChannel,
    releaseAcknowledged,
    releaseHandledWithoutPost,
    startNativeWork,
    waitForNativeWork,
    retryRetiredCourierWork
  };
}

module.exports = { createOwnerAdmission };
