'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePeerCaller } = require('./caller');
const { resolvePeerBinding, requireReadyPeer } = require('../../dist/peer/resolution');
const { AGENT_ROUTING_VERSION, resolveAgentReplyRequest } = require('../../dist/state/agent-routing');
const { readTextFile, resolveAgentAddress, runDirectPost } = require('../direct-post');
const { postByRole } = require('./post');
const { inspectPeerResult, validPeerId } = require('./result');
const { encodeAgentMessage, issueAgentAddress, KINDS } = require('../agent-message');
const { READINESS } = require('../state');
const { THREAD_STATES } = require('../state/thread-enrollment');

function canonicalNativeId(value) {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function samePeerBinding(left, right) {
  return left.active && left.guildId === right.guildId && left.channelId === right.channelId &&
    left.provider === right.provider && canonicalNativeId(left.nativeId) === canonicalNativeId(right.nativeId) &&
    left.generation === right.generation && (left.conductorId ?? null) === (right.conductorId ?? null) &&
    (left.repoKey ?? null) === (right.repoKey ?? null);
}

function currentPeerDestination(state, target, expectedBinding = null, expectedChildId = null) {
  if (!target || typeof target !== 'object') return false;
  const { guildId } = state.requireConfig();
  const candidates = state.listBindings().filter(binding =>
    binding.active && binding.guildId === guildId && binding.guildId === target.guildId &&
    binding.provider === target.provider && canonicalNativeId(binding.nativeId) === canonicalNativeId(target.nativeId) &&
    binding.generation === target.generation && (!expectedBinding || samePeerBinding(binding, expectedBinding))
  );
  const routes = candidates.filter(binding => {
    const children = state.listThreadEnrollments(binding.channelId).filter(child =>
      child.active && child.parentChannelId === binding.channelId && child.guildId === binding.guildId
    );
    const watermark = state.getIntakeWatermark(binding.channelId);
    const parentRoute = expectedBinding === null && expectedChildId === null && binding.channelId === target.channelId;
    const childRoute = children.length === 1 && children[0].state === THREAD_STATES.READY &&
      children[0].threadId === target.channelId &&
      (expectedChildId === null || expectedChildId === target.channelId);
    return binding.readiness === READINESS.READY &&
      (!watermark || watermark.state === READINESS.READY) && (parentRoute || childRoute);
  });
  return routes.length === 1;
}

function assertPeerPacketFits({ state, source, sourceAddress, destination, input, text, token }) {
  const kind = input.reply_to === undefined ? KINDS.REQUEST : KINDS.RESULT;
  const target = destination === null
    ? resolveAgentReplyRequest(state, input.reply_to, sourceAddress, null, {
      guildId: source.guildId, channelId: source.channelId, provider: source.provider,
      nativeId: source.nativeId, generation: source.generation
    }, Error).source
    : resolveAgentAddress(state, destination.binding, destination.childId);
  try {
    encodeAgentMessage({
      id: input.dedupe_key,
      kind,
      source: sourceAddress,
      target,
      replyTo: input.reply_to ?? null,
      routingVersion: AGENT_ROUTING_VERSION,
      ...(kind === KINDS.RESULT ? { sourceParentChannelId: source.channelId } : {}),
      text
    }, token);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('agent message exceeds Discord message limit:')) {
      throw new Error(`peer text exceeds signed packet limit: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

function createPeerService(context) {
  const { state, provider, token, stateDir, loadChannels, callerDependencies, fetchImpl } = context;
  const caller = signal => resolvePeerCaller(state, provider, callerDependencies, signal);
  const service = {
    async post(input, signal) { return postByRole(context, input, signal, service.send); },
    async result(correlationId, signal) { return inspectPeerResult(state, await caller(signal), correlationId); },
    async list(signal) {
      await caller(signal);
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
      const initial = await caller(signal);
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['peer', 'text', 'text_file', 'dedupe_key', 'reply_to'].includes(key))) {
        throw new Error('invalid peer send arguments');
      }
      if ((input.text === undefined) === (input.text_file === undefined)) throw new Error('provide exactly one of text or text_file');
      if ((input.peer === undefined) === (input.reply_to === undefined)) throw new Error('provide exactly one of peer or reply_to');
      if (!validPeerId(input.dedupe_key)) throw new Error('dedupe_key must be a valid packet id');
      if (input.reply_to !== undefined && !validPeerId(input.reply_to)) throw new Error('reply_to must be a valid packet id');
      if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 10000)) throw new Error('text must be non-empty and at most 10000 bytes');
      if (input.text_file !== undefined && (typeof input.text_file !== 'string' || !input.text_file.trim())) throw new Error('text_file must be non-empty');
      const channels = input.peer?.channelName ? await loadChannels(signal) : [];
      const source = await caller(signal);
      if (source.channelId !== initial.channelId || canonicalNativeId(source.nativeId) !== canonicalNativeId(initial.nativeId) || source.generation !== initial.generation) {
        throw new Error('peer caller changed during resolution');
      }
      const sourceRoute = requireReadyPeer(state, source);
      const sourceReadiness = source.readiness;
      const sourceIntakeState = state.getIntakeWatermark(source.channelId)?.state ?? null;
      const sourceAddress = resolveAgentAddress(state, source, sourceRoute.childId);
      let agentTarget = null;
      let destination = null;
      if (input.peer !== undefined) {
        destination = requireReadyPeer(state, resolvePeerBinding(state, input.peer, channels));
        agentTarget = issueAgentAddress(resolveAgentAddress(state, destination.binding, destination.childId), token);
      }
      const fileSource = input.text_file === undefined ? null : readTextFile(input.text_file);
      const text = fileSource === null ? input.text : fileSource.text;
      assertPeerPacketFits({ state, source, sourceAddress, destination, input, text, token });
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
          agentDestinationCurrent: target => {
            const currentSource = state.getBinding(source.channelId);
            const currentIntakeState = state.getIntakeWatermark(source.channelId)?.state ?? null;
            if (!currentSource || currentSource.readiness !== sourceReadiness || currentIntakeState !== sourceIntakeState) return false;
            requireReadyPeer(state, currentSource);
            return currentPeerDestination(state, target, destination?.binding || null, destination?.childId || null);
          },
          textFile, dedupeKey: input.dedupe_key, signal, fetchImpl,
          ...(fileSource === null ? {} : { preparedTextSource: fileSource }) });
        return { correlationId: input.dedupe_key, ...result };
      } finally {
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  };
  return service;
}

module.exports = { createPeerService };
