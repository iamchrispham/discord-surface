const { READINESS, MESSAGE_STATES } = require('../../src/state');
const { THREAD_STATES } = require('../../src/state/thread-enrollment');

const id = '11111111-1111-1111-1111-111111111111';
function addOrdinaryRecipient(f) {
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: '33333333-3333-3333-3333-333333333333',
    workspace: '/tmp' }, { intakeCutoff: '100' });
  f.state.markIntakeBoundary('301', 'ready', 'fixture history recovered');
  const target = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100', adoptionCutoff: '100' }, target);
  f.state.setThreadBaseline('302', '100', target);
  f.state.markThreadBoundary('302', 'ready', 'fixture', null, null, target);
  return target;
}

function addSecondRecipient(f) {
  f.state.bind({ guildId: '100', channelId: '301', provider: 'codex', nativeId: '33333333-3333-3333-3333-333333333333',
    workspace: '/tmp', conductorId: 'second-recipient', repoKey: 'github.com/test/second-recipient' }, { intakeCutoff: '100' });
  f.state.markIntakeBoundary('301', 'ready', 'fixture history recovered');
  const target = f.state.setBindingReadiness('301', READINESS.READY, 'fixture', f.state.getBinding('301'));
  f.state.enrollThread({ threadId: '302', parentChannelId: '301', guildId: '100', adoptionCutoff: '100' }, target);
  f.state.setThreadBaseline('302', '100', target);
  f.state.markThreadBoundary('302', THREAD_STATES.READY, 'fixture', null, null, target);
  return target;
}
const request = { peer: { conductorId: 'test-conductor' }, text: 'hello', dedupe_key: 'fixture-request' };

module.exports = { id, addOrdinaryRecipient, addSecondRecipient, request };
