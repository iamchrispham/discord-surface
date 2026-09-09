import {
  createOrdinaryCodexRequest,
  resolveExistingChannel,
  type ExistingDiscordChannel,
  type OrdinaryCodexIdentity,
  type OrdinaryCodexRequest
} from '../src/ordinary-codex';

const identity: OrdinaryCodexIdentity = {
  sessionId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  threadId: '9caa5d21-2169-429d-918b-5f08651b5dbd'
};
const channel: ExistingDiscordChannel = { id: '123', guildId: 'guild', name: 'ops', messageCapable: true };

createOrdinaryCodexRequest({ channelId: channel.id, guildId: channel.guildId, workspace: '/tmp/workspace', identity });
resolveExistingChannel('<#123>', 'guild', [channel]);

const wrongProvider: OrdinaryCodexRequest = {
  // @ts-expect-error ordinary requests accept Codex only
  provider: 'claude',
  channelId: channel.id,
  guildId: channel.guildId,
  nativeId: identity.sessionId,
  workspace: '/tmp/workspace',
  identity
};
void wrongProvider;
