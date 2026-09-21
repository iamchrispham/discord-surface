const { AGENT_ATTACHMENT_RECOVERY_KINDS } = require('../agent-attachment');
const { CODEX_VALIDATION_KINDS } = require('../native');

function createIntakeSerialization({ recoveryKind, recoveryError }) {
  const intakeQueues = new Map();
  const intakeBarriers = new Map();

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

  return { serializeIntake, releaseIntake };
}

module.exports = { createIntakeSerialization };
