const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SurfaceState, READINESS } = require('../../src/state');
const { THREAD_STATES } = require('../../src/state/thread-enrollment');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-resolution-'));
  const state = new SurfaceState(path.join(directory, 'surface.sqlite'));
  t.after(() => { state.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  state.setConfig({ guildId: '100', operatorId: '900', secretFile: path.join(directory, 'secret') });
  state.bind({ guildId: '100', channelId: '101', provider: 'claude',
    nativeId: '11111111-1111-1111-1111-111111111111', workspace: directory, endpoint: path.join(directory, 'channel.sock'),
    conductorId: 'test-conductor', repoKey: 'github.com/test/repo' });
  const ready = () => state.setBindingReadiness('101', READINESS.READY, 'fixture', state.getBinding('101'));
  ready();
  function enroll(id) {
    const binding = state.getBinding('101');
    state.enrollThread({ threadId: id, parentChannelId: '101', guildId: '100' }, binding);
    state.markThreadBoundary(id, THREAD_STATES.READY, 'fixture', null, null, binding);
  }
  return { state, ready, enroll };
}

module.exports = { fixture };
