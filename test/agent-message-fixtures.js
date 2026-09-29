const { KINDS } = require('../src/agent-message');
const { READINESS } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');

const source = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const target = { guildId: '100', channelId: '102', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222', generation: 2 };
const packet = { id: 'work-1', kind: KINDS.REQUEST, source, target, replyTo: null, text: 'Inspect the reported failure. Do not change ownership.' };
const token = 'isolated-test-credential';

function enrollChild(state, parent, threadId, baseline = '7000') {
  let binding = state.getBinding(parent.channelId);
  binding = state.setBindingReadiness(parent.channelId, READINESS.READY, 'fixture ready', binding);
  state.enrollThread({ threadId, parentChannelId: parent.channelId, guildId: parent.guildId, adoptionCutoff: '100'}, binding);
  if (baseline !== null) state.setThreadBaseline(threadId, baseline, binding);
  state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture adoption', null, null, binding);
  return { ...parent, channelId: threadId, generation: binding.generation };
}

module.exports = { source, target, packet, token, enrollChild };
