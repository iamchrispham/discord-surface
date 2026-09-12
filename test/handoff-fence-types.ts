import {
  assertOrdinaryIntakeRange,
  createHandoffFence,
  deleteHandoffFence,
  serverDerivedChannelCutoff,
  type HandoffBinding,
  type HandoffChannel,
  type HandoffState
} from '../src/discord/handoff-fence';

const channel: HandoffChannel = {
  id: '123456789012345678',
  send: async () => ({ id: '150', delete: async () => undefined }),
  messages: {
    fetch: async () => new Map([['latest', { id: '100' }]])
  }
};

const binding: HandoffBinding = { channelId: '123456789012345678' };
const state: HandoffState = {
  checkpointIntake: () => ({ state: 'ready' }),
  hasIntakeEvidence: () => true
};

void createHandoffFence(channel).then(fence => {
  void fence.id;
  return deleteHandoffFence(fence);
});
void assertOrdinaryIntakeRange(channel, state, binding, '100', '150', 'ordinary handoff');
const cutoff: string | null = serverDerivedChannelCutoff(channel);
void cutoff;

// @ts-expect-error A handoff binding must identify its channel.
const invalidBinding: HandoffBinding = {};
void invalidBinding;

// @ts-expect-error Intake state must provide both custody methods.
void assertOrdinaryIntakeRange(channel, { hasIntakeEvidence: () => true }, binding, '100', '150', 'ordinary handoff');
