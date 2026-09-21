const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SurfaceState, StateCorruptError, READINESS } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { CODEX_ID, fixture, attachmentMetadata, historyPermissions } = require('./surface-fixtures');

test('simulated: malformed required columns fail closed even with a known schema version', () => {
  const { db, state } = fixture();
  state.db.exec('ALTER TABLE bindings RENAME COLUMN active TO malformed_active');
  state.close();
  assert.throws(() => new SurfaceState(db), StateCorruptError);
});

test('simulated: v1.3 migration preserves a recorded cutoff and recovers older history after held live custody', async () => {
  const { dir, db, state } = fixture();
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.setIntakeBaseline('channel-codex', '100', 'recorded v1.3 cutoff');
  state.markIntakeBoundary('channel-codex', 'ready');
  state.acceptDiscordMessage({ id: '200', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'held live input' });
  state.close();
  const legacy = new DatabaseSync(db);
  legacy.exec("ALTER TABLE intake_watermarks DROP COLUMN recovered_through_id; UPDATE meta SET value='1.3' WHERE key='schema';");
  legacy.close();

  const migrated = new SurfaceState(db);
  assert.equal(migrated.getIntakeWatermark('channel-codex').recovered_through_id, '100');
  assert.equal(migrated.getBinding('channel-codex').readiness, READINESS.PENDING);
  const secret = path.join(dir, 'discord.env');
  fs.writeFileSync(secret, 'DISCORD_TOKEN=fake-token\n', { mode: 0o600 });
  const channel = { id: 'channel-codex', guildId: 'guild-1', topic: '', permissionsFor: () => historyPermissions() };
  const client = {
    user: { id: 'bot-1' },
    on() {}, off() {}, async login() {}, channels: { fetch: async () => channel }, async destroy() {}
  };
  const historyAttachment = attachmentMetadata({ filename: 'history.png', size: 654 });
  const gateway = new DiscordGateway({ state: migrated, client, fetchHistory: async (_channel, options) => {
    assert.equal(options.after, '100');
    return [
      { id: '200', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'held live input' },
      { id: '101', guildId: 'guild-1', channelId: 'channel-codex', author: { id: 'operator-1', bot: false }, content: 'older history', attachments: [historyAttachment] }
    ];
  } });
  await gateway.start(secret);
  assert.ok(migrated.getMessage('101'));
  assert.ok(migrated.getMessage('200'));
  assert.deepEqual(migrated.getMessage('101').attachments, [historyAttachment]);
  assert.equal(migrated.getIntakeWatermark('channel-codex').recovered_through_id, '200');
  await gateway.stop();
  migrated.close();
});

test('simulated: v1.4 migration adds empty attachment metadata to legacy messages', () => {
  const { dir, db, state } = fixture('legacy-attachments.sqlite');
  state.bind({ channelId: 'channel-codex', guildId: 'guild-1', provider: 'codex', nativeId: CODEX_ID, workspace: dir });
  state.acceptDiscordMessage({ id: 'legacy-text', guildId: 'guild-1', channelId: 'channel-codex', authorId: 'operator-1', isBot: false, content: 'legacy text' });
  state.db.exec("ALTER TABLE messages DROP COLUMN attachments; UPDATE meta SET value='1.4' WHERE key='schema';");
  state.close();

  const migrated = new SurfaceState(db);
  assert.deepEqual(migrated.getMessage('legacy-text').attachments, []);
  assert.equal(migrated.db.prepare("SELECT value FROM meta WHERE key='schema'").get().value, '1.8');
  migrated.close();
});
