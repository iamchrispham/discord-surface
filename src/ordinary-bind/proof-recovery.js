const { READINESS } = require('../state');

const ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX = 'Codex transcript proof unavailable before event write:';

function reconcileProofUnavailableIntake(state, binding, {
  reused,
  nativeProofVerified,
  nativeProofDetail,
  nativeProofError
}) {
  if (!reused || !nativeProofVerified || !nativeProofDetail || nativeProofError) return binding;
  const watermark = state.getIntakeWatermark(binding.channelId);
  const proofUnavailable = watermark &&
    (watermark.state === READINESS.UNAVAILABLE || watermark.state === READINESS.GAP) &&
    typeof watermark.detail === 'string' &&
    watermark.detail.startsWith(ORDINARY_NATIVE_PROOF_UNAVAILABLE_PREFIX);
  if (!proofUnavailable) return binding;
  const reopened = state.reconcileIntake(binding.channelId, binding);
  return reopened ? state.getBinding(binding.channelId) : binding;
}

module.exports = { reconcileProofUnavailableIntake };
