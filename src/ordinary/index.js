function createOrdinaryRepository({ state, assertOrdinaryIdentity, assertOrdinaryNativeIdentity }) {
  return Object.freeze({
    assertOrdinaryIdentity,
    assertOrdinaryNativeIdentity,
    bindOrdinary: (...args) => state._bindOrdinary(...args),
    bindOrdinaryClaude: (...args) => state._bindOrdinaryClaude(...args),
    rebindOrdinary: (...args) => state._rebindOrdinary(...args),
    rebindOrdinaryClaude: (...args) => state._rebindOrdinaryClaude(...args),
    isOrdinaryBindingRecord: (...args) => state._isOrdinaryBindingRecord(...args),
    isOrdinaryBinding: (...args) => state._isOrdinaryBinding(...args),
    hasOrdinaryPreflight: (...args) => state._hasOrdinaryPreflight(...args),
    recordOrdinaryPreflight: (...args) => state._recordOrdinaryPreflight(...args),
    findOrdinaryHandoff: (...args) => state._findOrdinaryHandoff(...args),
    handoffOrdinary: (...args) => state._handoffOrdinary(...args)
  });
}

module.exports = { createOrdinaryRepository };
