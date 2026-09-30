const { MESSAGE_STATES, PROVIDERS } = require('../state');

const REOFFER_RECEIPT_KINDS = Object.freeze({
  ATTEMPT: 'claude-reoffer-attempt',
  OUTCOME: 'claude-reoffer-outcome'
});

const DISPATCH_OUTCOMES = Object.freeze({ submitted: 'submitted', not_submitted: 'not_submitted', uncertain: 'uncertain' });
const LISTENER_INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

  async function post(state, gateway, binding, message, detail, isStopping) {
    if (isStopping?.()) return;
    const current = state.getMessage(message.id);
    if (!current || current.state !== MESSAGE_STATES.SUBMITTED) return;
    const route = state.currentMessageBinding(current);
    if (!route.current || !route.ready || route.binding?.endpoint !== binding.endpoint) return;
    if (state.hasNativeAcknowledgment(current)) return;
    state.receipt(current.id, REOFFER_RECEIPT_KINDS.ATTEMPT, detail);
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

  async function runBinding(state, gateway, binding, snapshot, isStopping) {
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
    // Store before dispatch: an outcome without a native ACK must not retry on this instance.
    verifiedInstances.set(binding.channelId, { ...detail, endpoint: binding.endpoint });
    for (const message of candidates(snapshot, binding)) {
      if (isStopping?.()) return;
      await post(state, gateway, binding, message, detail, isStopping);
    }
  }

  async function run({ gateway, isStopping } = {}) {
    const state = gateway?.state;
    if (!state || typeof state.listBindings !== 'function' || typeof gateway?.providers?.claude?.dispatch !== 'function') return;
    if (isStopping?.()) return;
    const snapshot = state.recoveryCandidates();
    for (const binding of state.listBindings()) {
      if (isStopping?.()) return;
      if (!binding.active || binding.provider !== PROVIDERS.CLAUDE || !binding.endpoint) continue;
      try {
        await runBinding(state, gateway, binding, snapshot, isStopping);
      } catch (error) {
        logger(error);
      }
    }
  }

  return { run, verifiedInstances };
}

module.exports = { createClaudeSubmittedReoffer, REOFFER_RECEIPT_KINDS };
