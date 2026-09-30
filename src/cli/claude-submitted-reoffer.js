const { MESSAGE_STATES, PROVIDERS } = require('../state');

const REOFFER_RECEIPT_KINDS = Object.freeze({
  ATTEMPT: 'claude-reoffer-attempt',
  OUTCOME: 'claude-reoffer-outcome'
});

const DISPATCH_OUTCOMES = Object.freeze({ submitted: 'submitted', not_submitted: 'not_submitted', uncertain: 'uncertain' });
const POST_OUTCOMES = Object.freeze({ deferred: 'deferred' });
const LISTENER_INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function attemptKey(messageId, detail) {
  return JSON.stringify([messageId, detail.nativeId, detail.generation, detail.listenerInstanceId]);
}

function attemptReceiptKeys(state) {
  if (typeof state.listReceipts !== 'function') return new Set();
  return new Set(state.listReceipts().flatMap(receipt => {
    if (receipt.kind !== REOFFER_RECEIPT_KINDS.ATTEMPT || !receipt.discord_id) return [];
    let detail;
    try { detail = typeof receipt.detail === 'string' ? JSON.parse(receipt.detail) : receipt.detail; }
    catch { return []; }
    return detail && typeof detail === 'object' && typeof detail.nativeId === 'string' &&
      typeof detail.listenerInstanceId === 'string'
      ? [attemptKey(receipt.discord_id, detail)]
      : [];
  }));
}

// Only a newly verified listener instance may re-offer; the map remembers the last
// verified instance per parent channel so a repeated wake stays inert.
function createClaudeSubmittedReoffer({ probeClaudeChannel, logger = error => process.stderr.write(`discord-surface: Claude re-offer failed: ${error.message}\n`) } = {}) {
  const verifiedInstances = new Map();

  async function probe(binding) {
    let proof;
    try {
      proof = await probeClaudeChannel(binding.endpoint, {
        nativeId: binding.nativeId,
        generation: binding.generation,
        workspace: binding.workspace,
        endpoint: binding.endpoint
      });
    } catch (error) {
      return null;
    }
    return typeof proof?.listenerInstanceId === 'string' && LISTENER_INSTANCE_ID.test(proof.listenerInstanceId)
      ? proof.listenerInstanceId
      : null;
  }

  function candidates(snapshot, binding) {
    return snapshot.filter(message => message && message.state === MESSAGE_STATES.SUBMITTED &&
      message.channelId === binding.channelId && message.provider === PROVIDERS.CLAUDE &&
      message.nativeId === binding.nativeId && message.generation === binding.generation);
  }

  async function post(state, gateway, binding, message, detail, attemptKeys, isStopping) {
    if (isStopping?.()) return;
    const current = state.getMessage(message.id);
    if (!current || current.state !== MESSAGE_STATES.SUBMITTED) return;
    const route = state.currentMessageBinding(current);
    if (!route.current || route.binding?.endpoint !== binding.endpoint) return;
    if (!route.ready) return POST_OUTCOMES.deferred;
    if (state.hasNativeAcknowledgment(current)) return;
    const key = attemptKey(current.id, detail);
    if (attemptKeys.has(key)) return;
    state.receipt(current.id, REOFFER_RECEIPT_KINDS.ATTEMPT, detail);
    attemptKeys.add(key);
    let outcome = DISPATCH_OUTCOMES.uncertain;
    try {
      const result = await gateway.providers.claude.dispatch(current);
      if (result?.status === DISPATCH_OUTCOMES.submitted || result?.status === DISPATCH_OUTCOMES.not_submitted) {
        outcome = result.status;
      }
    } catch (error) {
      logger(error);
    }
    state.receipt(current.id, REOFFER_RECEIPT_KINDS.OUTCOME, { ...detail, outcome });
  }

  async function runBinding(state, gateway, binding, snapshot, attemptKeys, isStopping) {
    const listenerInstanceId = await probe(binding);
    if (!listenerInstanceId || isStopping?.()) return;
    const current = state.getBinding(binding.channelId);
    if (!current || !current.active || current.provider !== PROVIDERS.CLAUDE ||
      current.nativeId !== binding.nativeId || current.generation !== binding.generation ||
      current.endpoint !== binding.endpoint) return;
    const previous = verifiedInstances.get(binding.channelId);
    if (previous && previous.nativeId === binding.nativeId && previous.generation === binding.generation &&
      previous.endpoint === binding.endpoint && previous.listenerInstanceId === listenerInstanceId) return;
    const detail = { nativeId: binding.nativeId, generation: binding.generation, listenerInstanceId };
    let deferred = false;
    for (const message of candidates(snapshot, binding)) {
      if (isStopping?.()) return;
      const result = await post(state, gateway, binding, message, detail, attemptKeys, isStopping);
      if (result === POST_OUTCOMES.deferred) deferred = true;
    }
    if (!deferred) {
      // A deferred candidate needs another wake even when the listener is unchanged.
      verifiedInstances.set(binding.channelId, { ...detail, endpoint: binding.endpoint });
    }
  }

  async function run({ gateway, isStopping } = {}) {
    const state = gateway?.state;
    if (!state || typeof state.listBindings !== 'function' || typeof gateway?.providers?.claude?.dispatch !== 'function') return;
    if (isStopping?.()) return;
    const snapshot = state.recoveryCandidates();
    const attemptKeys = attemptReceiptKeys(state);
    for (const binding of state.listBindings()) {
      if (isStopping?.()) return;
      if (!binding.active || binding.provider !== PROVIDERS.CLAUDE || !binding.endpoint) continue;
      try {
        await runBinding(state, gateway, binding, snapshot, attemptKeys, isStopping);
      } catch (error) {
        logger(error);
      }
    }
  }

  return { run, verifiedInstances };
}

module.exports = { createClaudeSubmittedReoffer, REOFFER_RECEIPT_KINDS };
