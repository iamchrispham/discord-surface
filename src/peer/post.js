'use strict';

const { resolvePeerCaller } = require('./caller');
const { requireReadyBinding } = require('../../dist/peer/resolution');
const { runDirectPost, resolveDirectBinding } = require('../direct-post');
const { runBoardRefresh } = require('../board-refresh');

const POST_ROLES = Object.freeze({ ANNOUNCE: 'announce', BOARD: 'board', CHILD: 'child' });

function bindingIdentityMatches(left, right) {
  return Boolean(left?.active) && left.guildId === right.guildId && left.channelId === right.channelId &&
    left.provider === right.provider && left.nativeId === right.nativeId && left.generation === right.generation &&
    (left.sessionRoot ?? null) === (right.sessionRoot ?? null) &&
    (left.conductorId ?? null) === (right.conductorId ?? null) && (left.repoKey ?? null) === (right.repoKey ?? null);
}

function readyBindingCurrent(state, expected) {
  const current = state.getBinding(expected.channelId);
  if (!bindingIdentityMatches(current, expected) || current.readiness !== expected.readiness) return false;
  try {
    requireReadyBinding(state, current);
    return true;
  } catch {
    return false;
  }
}

async function postByRole(context, input, signal, send) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.values(POST_ROLES).includes(input.role)) throw new Error('post role must be announce, board or child');
  const { role, ...args } = input;
  if (role === POST_ROLES.CHILD) return send(args, signal);
  const keys = role === POST_ROLES.BOARD ? ['text_file', 'dedupe_key', 'message_id'] : ['text_file', 'dedupe_key'];
  if (Object.keys(args).some(key => !keys.includes(key)) ||
      keys.some(key => typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`invalid ${role} arguments`);
  const { state, provider, token, stateDir, callerDependencies, fetchImpl } = context;
  const binding = await resolvePeerCaller(state, provider, callerDependencies, signal);
  requireReadyBinding(state, binding);
  const ordinary = state.isOrdinaryBindingRecord(binding);
  const common = { state, token, nativeId: binding.nativeId, generation: binding.generation,
    channelId: binding.channelId, textFile: args.text_file, dedupeKey: args.dedupe_key, signal, fetchImpl };
  const bindingCurrent = () => readyBindingCurrent(state, binding);
  if (role === POST_ROLES.ANNOUNCE) return runDirectPost({ ...common, provider, ordinary, stateDir, bindingCurrent });
  if (ordinary) throw new Error('board updates require a conductor binding');
  return runBoardRefresh({ ...common, messageId: args.message_id,
    bindingCurrent,
    resolveBinding: (surfaceState, identity) => resolveDirectBinding(surfaceState, { ...identity, provider, ordinary: false }) });
}

module.exports = { POST_ROLES, postByRole };
