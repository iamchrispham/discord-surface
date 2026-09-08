function pauseOrdinaryHandoffIntake(state, channelId, expectedBinding, pendingState, detail) {
  state.ordinaryHandoffPauses.add(channelId);
  try {
    const result = state.markIntakeBoundary(channelId, pendingState, detail, null, null, expectedBinding);
    if (!result) state.ordinaryHandoffPauses.delete(channelId);
    return result;
  } catch (error) {
    state.ordinaryHandoffPauses.delete(channelId);
    throw error;
  }
}

function intakeCutoffDecision(eventId, cutoffId, compare) {
  if (cutoffId === null) return null;
  if (!/^\d+$/.test(eventId) || !/^\d+$/.test(cutoffId)) return 'incomparable-intake-cutoff';
  return compare(eventId, cutoffId) <= 0 ? 'before-intake-cutoff' : null;
}

module.exports = { intakeCutoffDecision, pauseOrdinaryHandoffIntake };
