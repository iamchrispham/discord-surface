'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePeerCaller } = require('./caller');
const { resolvePeerBinding, requireReadyPeer } = require('../../dist/peer/resolution');
const { resolveAgentAddress, runDirectPost } = require('../direct-post');
const { postByRole } = require('./post');
const { inspectPeerResult } = require('./result');
const { issueAgentAddress } = require('../agent-message');

function createPeerService(context) {
  const { state, provider, token, stateDir, loadChannels, callerDependencies, fetchImpl } = context;
  const caller = () => resolvePeerCaller(state, provider, callerDependencies);
  const service = {
    async post(input, signal) { return postByRole(context, input, signal, service.send); },
    async result(correlationId) { return inspectPeerResult(state, await caller(), correlationId); },
    async list() {
      await caller();
      const { guildId } = state.requireConfig();
      return state.listBindings().filter(binding => binding.active && binding.guildId === guildId).map(binding => {
        let childId = null;
        let reason = null;
        try { childId = requireReadyPeer(state, binding).childId; }
        catch (error) { reason = error.message; }
        return { repoKey: binding.repoKey, provider: binding.provider, conductorId: binding.conductorId,
          channelId: binding.channelId, generation: binding.generation, readiness: binding.readiness,
          childId, reachable: reason === null, reason };
      });
    },
    async send(input, signal) {
      const initial = await caller();
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['peer', 'text', 'text_file', 'dedupe_key', 'reply_to'].includes(key))) {
        throw new Error('invalid peer send arguments');
      }
      if ((input.text === undefined) === (input.text_file === undefined)) throw new Error('provide exactly one of text or text_file');
      if ((input.peer === undefined) === (input.reply_to === undefined)) throw new Error('provide exactly one of peer or reply_to');
      if (typeof input.dedupe_key !== 'string' || !input.dedupe_key.trim() || input.dedupe_key.length > 256) throw new Error('dedupe_key is required');
      if (input.reply_to !== undefined && (typeof input.reply_to !== 'string' || !input.reply_to.trim())) throw new Error('reply_to must be non-empty');
      if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 10000)) throw new Error('text must be non-empty and at most 10000 bytes');
      if (input.text_file !== undefined && (typeof input.text_file !== 'string' || !input.text_file.trim())) throw new Error('text_file must be non-empty');
      const channels = input.peer?.channelName ? await loadChannels(signal) : [];
      const source = await caller();
      if (source.channelId !== initial.channelId || source.nativeId !== initial.nativeId || source.generation !== initial.generation) {
        throw new Error('peer caller changed during resolution');
      }
      const sourceRoute = requireReadyPeer(state, source);
      resolveAgentAddress(state, source, sourceRoute.childId);
      let agentTarget = null;
      if (input.peer !== undefined) {
        const destination = requireReadyPeer(state, resolvePeerBinding(state, input.peer, channels));
        agentTarget = issueAgentAddress(resolveAgentAddress(state, destination.binding, destination.childId), token);
      }
      let directory;
      try {
        let textFile = input.text_file;
        if (input.text !== undefined) {
          directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-peer-'));
          fs.chmodSync(directory, 0o700);
          textFile = path.join(directory, 'message.txt');
          fs.writeFileSync(textFile, input.text, { mode: 0o600 });
        }
        const result = await runDirectPost({ state, token, stateDir, provider,
          nativeId: source.nativeId, generation: source.generation, channelId: source.channelId,
          ordinary: state.isOrdinaryBindingRecord(source), agentMode: true,
          agentThreadId: sourceRoute.childId, agentTarget, agentKind: input.reply_to === undefined ? 'request' : 'result',
          agentReplyTo: input.reply_to ?? null, agentPresentation: 'attachment-v1',
          textFile, dedupeKey: input.dedupe_key, signal, fetchImpl });
        return { correlationId: input.dedupe_key, ...result };
      } finally {
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  };
  return service;
}

module.exports = { createPeerService };
