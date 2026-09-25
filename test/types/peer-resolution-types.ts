import {
  requireReadyPeer,
  resolvePeerBinding,
  type PeerBinding,
  type PeerSelector
} from '../../src/peer/resolution';

const binding: PeerBinding = {
  active: true,
  guildId: 'guild',
  channelId: 'channel',
  provider: 'codex',
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  generation: 1,
  conductorId: 'conductor',
  repoKey: 'repo',
  readiness: 'ready'
};

const selector: PeerSelector = { repoKey: 'repo', provider: 'codex' };
const byConductor: PeerSelector = { conductorId: 'conductor' };
const byChannelId: PeerSelector = { channelId: 'channel' };
const byChannel: PeerSelector = { channelName: 'peer' };

// @ts-expect-error peer providers are finite
const invalidSelector: PeerSelector = { repoKey: 'repo', provider: 'other' };
// @ts-expect-error readiness is finite
const invalidBinding: PeerBinding = { ...binding, readiness: 'online' };

const state: Parameters<typeof resolvePeerBinding>[0] = {
  db: { prepare: () => ({ get: () => ({ detail: '{}' }) }) },
  requireConfig: () => ({ guildId: binding.guildId }),
  listBindings: () => [binding],
  listThreadEnrollments: () => [{
    threadId: 'thread', parentChannelId: binding.channelId, guildId: binding.guildId,
    active: true, state: 'ready'
  }],
  getIntakeWatermark: () => ({ state: 'ready' })
};

const resolved: PeerBinding = resolvePeerBinding(state, selector);
const ready = requireReadyPeer(state, resolved);
const childId: string = ready.childId;

void byConductor;
void byChannelId;
void byChannel;
void invalidSelector;
void invalidBinding;
void childId;
