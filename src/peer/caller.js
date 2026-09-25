'use strict';

const { resolveInvocationIdentity } = require('../ordinary-codex');

async function resolvePeerCaller(state, provider, dependencies = {}) {
  let nativeId;
  if (provider === 'codex') {
    const identity = resolveInvocationIdentity(dependencies.environment || process.env);
    nativeId = identity.sessionId;
  } else if (provider === 'claude') {
    const resolve = dependencies.resolveClaudeCaller || require('../cli').resolveCurrentClaudeCaller;
    const identity = await resolve();
    if (identity?.harness !== 'claude-code' || typeof identity.sessionId !== 'string') {
      throw new Error('peer caller identity is unavailable or uses the wrong harness');
    }
    nativeId = identity.sessionId;
  } else {
    throw new Error('peer caller provider must be codex or claude');
  }
  const { guildId } = state.requireConfig();
  const bindings = state.listBindings().filter(binding => binding.active && binding.guildId === guildId &&
    binding.provider === provider && binding.nativeId === nativeId);
  if (bindings.length !== 1) {
    throw new Error(bindings.length ? 'peer caller binding is ambiguous' : 'peer caller has no active binding');
  }
  return bindings[0];
}

module.exports = { resolvePeerCaller };
