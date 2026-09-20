const { READINESS } = require('../state');

const ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX = 'Codex transcript proof unavailable before event write:';

function reconcileProofUnavailableIntake(state, binding, {
  reused,
  nativeProofVerified,
  nativeProofDetail,
  nativeProofError
}) {
  if (!reused || !nativeProofVerified || !nativeProofDetail || nativeProofError) return binding;
  const reopened = state.reconcileIntake(binding.channelId, binding, {
    states: [READINESS.UNAVAILABLE, READINESS.GAP],
    detailPrefix: ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX
  });
  return reopened ? state.getBinding(binding.channelId) : binding;
}

module.exports = { reconcileProofUnavailableIntake };
