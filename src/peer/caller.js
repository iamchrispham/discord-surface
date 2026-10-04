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

function createCallerAssertion(state, provider, dependencies = {}, capturedCaller) {
  const expected = Object.freeze({
    provider: capturedCaller?.provider,
    guildId: capturedCaller?.guildId,
    channelId: capturedCaller?.channelId,
    nativeId: canonicalNativeId(capturedCaller?.nativeId),
    generation: capturedCaller?.generation
  });
  return async function assertCallerCurrent(signal) {
    const current = await resolvePeerCaller(state, provider, dependencies, signal);
    if (current.provider !== expected.provider ||
        current.guildId !== expected.guildId ||
        current.channelId !== expected.channelId ||
        canonicalNativeId(current.nativeId) !== expected.nativeId ||
        current.generation !== expected.generation) {
      throw new Error('native caller must be revalidated: peer caller changed');
    }
  };
}

async function resolvePeerCaller(state, provider, dependencies = {}, signal) {
  if (signal?.aborted) throw abortError(signal);
  let nativeId;
  if (provider === 'codex') {
    const resolve = dependencies.resolveCodexCaller;
    if (resolve === undefined) {
      const identity = resolveInvocationIdentity(dependencies.environment || process.env);
      nativeId = identity.sessionId;
    } else {
      if (typeof resolve !== 'function') throw new Error('peer Codex caller resolver must be a function');
      const identity = await observeAbort(Promise.resolve().then(() => resolve(signal)), signal);
      if (typeof identity?.sessionId !== 'string' || identity.sessionId.trim() === '' ||
        typeof identity.threadId !== 'string' || identity.threadId.trim() === '' ||
        typeof identity.turnId !== 'string' || identity.turnId.trim() === '' ||
        identity.threadId !== identity.sessionId) {
        throw new Error('peer caller Codex turn identity is unavailable or conflicting');
      }
      nativeId = identity.sessionId;
    }
  } else if (provider === 'claude') {
    const resolve = dependencies.resolveClaudeCaller || require('../cli').resolveCurrentClaudeCaller;
    const identity = await observeAbort(Promise.resolve().then(() => resolve(signal)), signal);
    if (identity?.harness !== 'claude-code' || typeof identity.sessionId !== 'string') {
      throw new Error('peer caller identity is unavailable or uses the wrong harness');
    }
    if (identity.threadId != null && identity.threadId !== identity.sessionId) {
      throw new Error('peer caller identity has conflicting Claude thread and session');
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

module.exports = { resolvePeerCaller, createCallerAssertion };
