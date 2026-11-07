const { COURIER_OUTCOMES, COURIER_RECOVERY_TRIGGERS } = require('../state/courier-route');
const { MESSAGE_STATES } = require('../state');

function createCourierPickupDeadline(state, messageId, signal, timeoutMs = 120000) {
  const observer = new AbortController();
  let timer = null;
  let armed = false;
  let retired = false;
  let finishDeadline;
  const deadline = new Promise(resolve => { finishDeadline = resolve; });
  const onAbort = () => {
    observer.abort();
    finishDeadline();
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  function arm() {
    if (armed || signal?.aborted) return;
    const record = state.getCourierAttempt(messageId);
    const createdAt = Date.parse(record?.outcome?.createdAt || '');
    if (record?.outcome?.outcome !== COURIER_OUTCOMES.SUBMITTED ||
        !Number.isFinite(createdAt) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    armed = true;
    timer = setTimeout(() => {
      timer = null;
      if (!signal?.aborted) {
        try {
          const recovered = state.recoverCourierAttempt(messageId, record.attempt.attemptId, COURIER_RECOVERY_TRIGGERS.PICKUP_DEADLINE);
          retired = recovered.retired && !recovered.duplicate;
          if (retired) observer.abort();
        } catch {
          // A claim, acknowledgment, changed binding, or newer attempt keeps its custody.
        }
      }
      finishDeadline();
    }, Math.max(0, createdAt + timeoutMs - Date.now()));
  }

  async function shouldDispatchParent() {
    if (armed && !retired && !signal?.aborted &&
        state.getMessage(messageId)?.state === MESSAGE_STATES.SUBMITTED) await deadline;
    return retired && !signal?.aborted;
  }

  function close() {
    if (timer) clearTimeout(timer);
    finishDeadline();
    signal?.removeEventListener('abort', onAbort);
  }

  return { signal: observer.signal, arm, shouldDispatchParent, close };
}

module.exports = { createCourierPickupDeadline };
