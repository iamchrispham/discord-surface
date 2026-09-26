'use strict';

const { resolveInvocationIdentity } = require('../ordinary-codex');

function canonicalNativeId(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('peer server is closing');
}

function observeAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

async function resolvePeerCaller(state, provider, dependencies = {}, signal) {
  let nativeId;
  if (provider === 'codex') {
    const identity = resolveInvocationIdentity(dependencies.environment || process.env);
    nativeId = identity.sessionId;
  } else if (provider === 'claude') {
    const resolve = dependencies.resolveClaudeCaller || require('../cli').resolveCurrentClaudeCaller;
    const identity = await observeAbort(Promise.resolve().then(() => resolve(signal)), signal);
    if (identity?.harness !== 'claude-code' || typeof identity.sessionId !== 'string') {
      throw new Error('peer caller identity is unavailable or uses the wrong harness');
    }
    nativeId = identity.sessionId;
  } else {
    throw new Error('peer caller provider must be codex or claude');
  }
  const { guildId } = state.requireConfig();
  const canonicalId = canonicalNativeId(nativeId);
  const bindings = state.listBindings().filter(binding => binding.active && binding.guildId === guildId &&
    binding.provider === provider && canonicalNativeId(binding.nativeId) === canonicalId);
  if (bindings.length !== 1) {
    throw new Error(bindings.length ? 'peer caller binding is ambiguous' : 'peer caller has no active binding');
  }
  return bindings[0];
}

module.exports = { resolvePeerCaller };
