const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeAgentMessage, decodeAgentMessage, KINDS } = require('../src/agent-message');
const { ChannelType, Collection } = require('discord.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { messageRequest } = require('../src/native');
const { staticConductorMarker } = require('../src/topic');
const { createSurfaceConsumer, DiscordGateway, fetchAgentAttachment, waitForRecoveryOperation } = require('../src/discord');
const { recoverThread } = require('../src/discord/thread-enrollment');
const { attachmentUrlAllowed } = require('../src/agent-attachment');

const source = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const target = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222', generation: 2 };
const packet = { id: 'work-1', kind: KINDS.REQUEST, source, target, replyTo: null, text: 'Inspect the reported failure. Do not change ownership.' };
const token = 'isolated-test-credential';

// Parent recovery still handles results whose immutable custody predates child routing.
function encodeLegacyParentResult(state, value, credential) {
  const result = { ...value, source: { ...value.source, channelId: `${value.source.channelId}99` }, kind: KINDS.RESULT, replyTo: `request-${value.id}`, routingVersion: 2, sourceParentChannelId: value.source.channelId };
  state.receipt(null, 'direct-post-outcome', {
    outcome: 'sent', agentPacket: { id: result.replyTo, kind: KINDS.REQUEST,
      source: result.target, target: value.source, replyTo: null, text: 'Original request.' }
  });
  return encodeAgentMessage(result, credential);
}

async function waitForCondition(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), message);
}

function createTestGate(label, timeoutMs = 3000) {
  let settled = false;
  let timer;
  let resolveGate;
  let rejectGate;
  const settle = (callback, value) => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    callback(value);
    return true;
  };
  const promise = new Promise((resolve, reject) => {
    resolveGate = value => settle(resolve, value);
    rejectGate = error => settle(reject, error);
    timer = setTimeout(() => rejectGate(new Error(label + ' deadline exceeded')), timeoutMs);
  });
  promise.catch(() => {});
  return {
    promise,
    resolve: value => resolveGate(value),
    reject: error => rejectGate(error),
    isSettled: () => settled
  };
}

module.exports = {
  test,
  assert,
  encodeAgentMessage,
  decodeAgentMessage,
  KINDS,
  ChannelType,
  Collection,
  fs,
  os,
  path,
  SurfaceState,
  READINESS,
  THREAD_STATES,
  messageRequest,
  staticConductorMarker,
  createSurfaceConsumer,
  DiscordGateway,
  fetchAgentAttachment,
  waitForRecoveryOperation,
  recoverThread,
  attachmentUrlAllowed,
  source,
  target,
  packet,
  token,
  encodeLegacyParentResult,
  waitForCondition,
  createTestGate
};
