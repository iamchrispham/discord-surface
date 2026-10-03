'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePeerCaller, createCallerAssertion } = require('./caller');
const { resolvePeerBinding, validatePeerSelector, requireReadyPeer } = require('../../dist/peer/resolution');
const { AGENT_ROUTING_VERSION, resolveAgentReplyRequest, resolveAgentReplyRequestMatch } = require('../../dist/state/agent-routing');
const { readTextFile, resolveAgentAddress, runDirectPost } = require('../direct-post');
const { postByRole } = require('./post');
const { inspectPeerResult, validPeerId } = require('./result');
const { encodeAgentMessage, issueAgentAddress, sameAddress, KINDS } = require('../agent-message');
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

function currentPeerDestination(state, target, expectedBinding = null, expectedChildId = null, allowUnreadyChild = false) {
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
    const parentRoute = binding.channelId === target.channelId &&
      (!expectedBinding || samePeerBinding(binding, expectedBinding));
    const childRoute = children.some(child => (allowUnreadyChild || child.state === THREAD_STATES.READY) &&
      child.threadId === target.channelId &&
      (expectedChildId === null || expectedChildId === child.threadId));
    return binding.readiness === READINESS.READY &&
      (!watermark || watermark.state === READINESS.READY) && (parentRoute || childRoute);
  });
  return routes.length === 1;
}

function requireReadyReplyPeer(state, binding) {
  try {
    return requireReadyPeer(state, binding);
  } catch (error) {
    const watermark = state.getIntakeWatermark(binding.channelId);
    if (binding.active && binding.readiness === READINESS.READY &&
        (!watermark || watermark.state === READINESS.READY)) {
      return { binding, childId: null };
    }
    throw error;
  }
}

function replySourceSelectors(state, destination) {
  if (destination === null) return [null];
  const { binding, childId } = destination;
  const parent = {
    guildId: binding.guildId, channelId: binding.channelId, provider: binding.provider,
    nativeId: binding.nativeId, generation: binding.generation
  };
  const activeChildren = state.listThreadEnrollments(binding.channelId)
    .filter(child => child.active && child.parentChannelId === binding.channelId &&
      child.guildId === binding.guildId && (childId === null || child.threadId !== childId))
    .map(child => resolveAgentAddress(state, binding, child.threadId));
  const children = childId === null
    ? activeChildren
    : [resolveAgentAddress(state, binding, childId), ...activeChildren];
  return [...children, parent];
}

function samePeerSource(detail, source, binding) {
  const packets = [detail?.agentPacket, detail?.legacyAgentPacket]
    .filter(packet => packet && typeof packet === 'object' && packet.source);
  const persistedBinding = detail?.binding && typeof detail.binding === 'object' && !Array.isArray(detail.binding)
    ? detail.binding : detail;
  const sameOwner = packetSource => packetSource && packetSource.guildId === source.guildId &&
    packetSource.provider === source.provider &&
    canonicalNativeId(packetSource.nativeId) === canonicalNativeId(source.nativeId) &&
    packetSource.generation === source.generation;
  if (packets.length > 0) return packets.some(packet => sameAddress(packet.source, source) ||
    sameAddress(packet.source, { ...source, channelId: binding.channelId }) ||
    (sameOwner(packet.source) && persistedBinding?.channelId === binding.channelId));
  return detail?.guildId === binding.guildId && detail?.channelId === binding.channelId &&
    detail?.provider === binding.provider && canonicalNativeId(detail?.nativeId) === canonicalNativeId(binding.nativeId) &&
    detail?.generation === binding.generation;
}

function callerCustodyKey(packetId, source, binding) {
  const parentSource = { ...source, channelId: binding.channelId, nativeId: canonicalNativeId(source.nativeId) };
  return `peer:${crypto.createHash('sha256').update(JSON.stringify([packetId, parentSource])).digest('hex')}`;
}

function custodyKeyFor(state, packetId, source, binding) {
  const rows = state.directPostRows(packetId);
  if (rows.some(row => samePeerSource(row.detail, source, binding))) return undefined;
  return rows.length > 0 ? callerCustodyKey(packetId, source, binding) : undefined;
}

function frozenReplySourceRoute(state, replyTo, source, destination = null) {
  const sourceAddress = {
    guildId: source.guildId, channelId: source.channelId, provider: source.provider,
    nativeId: source.nativeId, generation: source.generation
  };
  const matches = [];
  for (const selector of replySourceSelectors(state, destination)) {
    try {
      const match = resolveAgentReplyRequestMatch(state, replyTo, sourceAddress, selector, sourceAddress, Error, false);
      if (match.frozenChildRoute) matches.push(match);
    } catch (error) {
      if (error instanceof Error &&
          ['agent reply target is unknown or does not match the active request', 'agent request was withdrawn'].includes(error.message)) {
        continue;
      }
      throw error;
    }
  }
  if (matches.length > 1) throw new Error('agent reply target is ambiguous across parent and child routes');
  return matches.length === 1 ? { binding: source, childId: matches[0].frozenChildRoute } : null;
}

function assertPeerPacketFits({ state, source, sourceAddress, destination, input, text, token }) {
  const kind = input.reply_to === undefined ? KINDS.REQUEST : KINDS.RESULT;
  const callerAddress = {
    guildId: source.guildId, channelId: source.channelId, provider: source.provider,
    nativeId: source.nativeId, generation: source.generation
  };
  let target;
  if (kind === KINDS.RESULT) {
    let lastError;
    let withdrawalError;
    const matches = [];
    for (const selector of replySourceSelectors(state, destination)) {
      try {
        matches.push(resolveAgentReplyRequest(state, input.reply_to, sourceAddress, selector, callerAddress, Error, false, true).source);
      } catch (error) {
        if (error instanceof Error && error.message === 'agent request was withdrawn') {
          withdrawalError = error;
          continue;
        }
        if (!(error instanceof Error) || error.message !== 'agent reply target is unknown or does not match the active request') {
          throw error;
        }
        lastError = error;
      }
    }
    if (matches.length > 1) throw new Error('agent reply target is ambiguous across parent and child routes');
    if (matches.length === 1) target = matches[0];
    else throw withdrawalError ?? lastError;
  } else {
    target = resolveAgentAddress(state, destination.binding, destination.childId);
  }
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
  return target;
}

function createPeerService(context) {
  const { state, provider, token, stateDir, loadChannels, callerDependencies, fetchImpl } = context;
  const caller = signal => resolvePeerCaller(state, provider, callerDependencies, signal);
  const service = {
    async post(input, signal) { return postByRole(context, input, signal, service.send); },
    async result(correlationId, signal) {
      const callerBinding = await caller(signal);
      const result = await inspectPeerResult(state, callerBinding, correlationId);
      const currentCallerBinding = await caller(signal);
      const callerAddress = {
        guildId: callerBinding.guildId, channelId: callerBinding.channelId,
        provider: callerBinding.provider, nativeId: canonicalNativeId(callerBinding.nativeId),
        generation: callerBinding.generation
      };
      const currentCallerAddress = {
        guildId: currentCallerBinding.guildId, channelId: currentCallerBinding.channelId,
        provider: currentCallerBinding.provider, nativeId: canonicalNativeId(currentCallerBinding.nativeId),
        generation: currentCallerBinding.generation
      };
      if (!sameAddress(callerAddress, currentCallerAddress)) {
        throw new Error('peer caller changed during result inspection');
      }
      return result;
    },
    async list(signal) {
      const callerBinding = await caller(signal);
      const { guildId } = state.requireConfig();
      return state.listBindings().filter(binding => binding.active && binding.guildId === guildId).map(binding => {
        let childId = null;
        let reason = null;
        try { childId = requireReadyPeer(state, binding).childId; }
        catch (error) { reason = error.message; }
        if (binding.channelId === callerBinding.channelId && reason === null) reason = 'caller cannot target itself';
        return { repoKey: binding.repoKey, provider: binding.provider, conductorId: binding.conductorId,
          channelId: binding.channelId, generation: binding.generation, readiness: binding.readiness,
          childId, reachable: reason === null && binding.channelId !== callerBinding.channelId, reason };
      });
    },
    async send(input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['peer', 'text', 'text_file', 'dedupe_key', 'reply_to'].includes(key))) {
        throw new Error('invalid peer send arguments');
      }
      if ((input.text === undefined) === (input.text_file === undefined)) throw new Error('provide exactly one of text or text_file');
      if (input.peer === undefined && input.reply_to === undefined) throw new Error('provide peer or reply_to');
      if (!validPeerId(input.dedupe_key)) throw new Error('dedupe_key must be a valid packet id');
      if (input.reply_to !== undefined && !validPeerId(input.reply_to)) throw new Error('reply_to must be a valid packet id');
      if (input.peer !== undefined) validatePeerSelector(input.peer);
      if (input.text !== undefined && (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 10000)) throw new Error('text must be non-empty and at most 10000 bytes');
      if (input.text !== undefined && Buffer.from(input.text, 'utf8').toString('utf8') !== input.text) throw new Error('text must round-trip losslessly through UTF-8');
      if (input.text_file !== undefined && (typeof input.text_file !== 'string' || !input.text_file.trim())) throw new Error('text_file must be non-empty');
      const initial = await caller(signal);
      const initialCurrent = createCallerAssertion(state, provider, callerDependencies, initial);
      // The channel-list lookup is a network effect too. Assert before and after
      // it, including when it rejects: a caller refusal escapes, and otherwise
      // the original lookup error propagates unchanged.
      let channels = [];
      if (input.peer && Object.hasOwn(input.peer, 'channelName')) {
        await initialCurrent(signal);
        let listed = null;
        let lookupError = null;
        try { listed = await loadChannels(signal); }
        catch (error) { lookupError = error; }
        await initialCurrent(signal);
        if (lookupError !== null) throw lookupError;
        channels = listed;
      }
      const source = await caller(signal);
      if (source.channelId !== initial.channelId || canonicalNativeId(source.nativeId) !== canonicalNativeId(initial.nativeId) || source.generation !== initial.generation) {
        throw new Error('peer caller changed during resolution');
      }
      const assertCallerCurrent = createCallerAssertion(state, provider, callerDependencies, source);
      let agentTarget = null;
      let destination = null;
      let destinationBinding = null;
      if (input.peer !== undefined) {
        destinationBinding = resolvePeerBinding(state, input.peer, channels);
        destination = input.reply_to === undefined
          ? requireReadyPeer(state, destinationBinding)
          : requireReadyReplyPeer(state, destinationBinding);
      }
      const frozenSourceRoute = input.reply_to === undefined
        ? null
        : frozenReplySourceRoute(state, input.reply_to, source,
          destination);
      const sourceRoute = frozenSourceRoute || requireReadyPeer(state, source);
      const sourceReadiness = source.readiness;
      const sourceIntakeState = state.getIntakeWatermark(source.channelId)?.state ?? null;
      const sourceAddress = resolveAgentAddress(state, source, sourceRoute.childId);
      if (input.reply_to === undefined && destination !== null) {
        agentTarget = issueAgentAddress(resolveAgentAddress(state, destination.binding, destination.childId), token);
      }
      const fileSource = input.text_file === undefined ? null : readTextFile(input.text_file);
      const text = fileSource === null ? input.text : fileSource.text;
      const packetTarget = assertPeerPacketFits({ state, source, sourceAddress, destination, input, text, token });
      const custodyKey = custodyKeyFor(state, input.dedupe_key, sourceAddress, source);
      if (input.reply_to !== undefined && destination !== null) {
        agentTarget = issueAgentAddress(packetTarget, token);
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
          ordinary: state.isOrdinaryBindingRecord(source), agentMode: true, peerRouting: true,
          agentThreadId: sourceRoute.childId, agentTarget, agentKind: input.reply_to === undefined ? 'request' : 'result',
          agentReplyTo: input.reply_to ?? null, agentPresentation: 'attachment-v1',
          agentDestinationCurrent: target => {
            const currentSource = state.getBinding(source.channelId);
            const currentIntakeState = state.getIntakeWatermark(source.channelId)?.state ?? null;
            if (!currentSource || currentSource.readiness !== sourceReadiness || currentIntakeState !== sourceIntakeState) return false;
            if (input.reply_to === undefined) {
              requireReadyPeer(state, currentSource);
            } else {
              const currentSourceRoute = state.getMessageRoute?.(sourceRoute.childId);
              if (!currentSourceRoute || !samePeerBinding(currentSourceRoute.binding, currentSource) ||
                  (!frozenSourceRoute && !currentSourceRoute.ready)) return false;
            }
            if (input.reply_to === undefined && destination?.binding) {
              const currentDestination = state.getBinding(destination.binding.channelId);
              if (!currentDestination || !samePeerBinding(currentDestination, destination.binding)) return false;
              requireReadyPeer(state, currentDestination);
            }
            return currentPeerDestination(state, target, destination?.binding || null,
              input.reply_to === undefined ? null : target?.channelId ?? null,
              input.reply_to !== undefined);
          },
          textFile, dedupeKey: input.dedupe_key, custodyKey, signal, fetchImpl,
          assertCallerCurrent,
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
