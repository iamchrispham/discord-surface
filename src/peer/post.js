'use strict';

const { resolvePeerCaller } = require('./caller');
const { requireReadyBinding } = require('../../dist/peer/resolution');
const { runDirectPost, resolveDirectBinding } = require('../direct-post');
const { runBoardRefresh } = require('../board-refresh');

const POST_ROLES = Object.freeze({ ANNOUNCE: 'announce', BOARD: 'board', CHILD: 'child' });

async function postByRole(context, input, signal, send) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.values(POST_ROLES).includes(input.role)) throw new Error('post role must be announce, board or child');
  const { role, ...args } = input;
  if (role === POST_ROLES.CHILD) return send(args, signal);
  const keys = role === POST_ROLES.BOARD ? ['text_file', 'dedupe_key', 'message_id'] : ['text_file', 'dedupe_key'];
  if (Object.keys(args).some(key => !keys.includes(key)) ||
      keys.some(key => typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`invalid ${role} arguments`);
  const { state, provider, token, stateDir, callerDependencies, fetchImpl } = context;
  const binding = await resolvePeerCaller(state, provider, callerDependencies);
  requireReadyBinding(state, binding);
  const ordinary = state.isOrdinaryBindingRecord(binding);
  const common = { state, token, nativeId: binding.nativeId, generation: binding.generation,
    channelId: binding.channelId, textFile: args.text_file, dedupeKey: args.dedupe_key, signal, fetchImpl };
  if (role === POST_ROLES.ANNOUNCE) return runDirectPost({ ...common, provider, ordinary, stateDir });
  if (ordinary) throw new Error('board updates require a conductor binding');
  return runBoardRefresh({ ...common, messageId: args.message_id,
    resolveBinding: (surfaceState, identity) => resolveDirectBinding(surfaceState, { ...identity, provider, ordinary: false }) });
}

module.exports = { POST_ROLES, postByRole };
