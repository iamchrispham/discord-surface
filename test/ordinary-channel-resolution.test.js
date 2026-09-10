const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const facade = require('../src/ordinary-bind/channel-resolution');
const emitted = require('../dist/ordinary-bind/channel-resolution');

function channel(id, guildId, name, messageCapable = true) {
  return { id, guildId, name, isTextBased: () => messageCapable };
}

function guildWith(directChannel, fetchedChannels) {
  return {
    channels: {
      fetch: async selection => selection ? directChannel : fetchedChannels
    }
  };
}

test('CommonJS facade exposes emitted channel resolution and preserves fetched object identity', async () => {
  assert.equal(facade.resolveDiscordChannel, emitted.resolveDiscordChannel);
  const fetched = channel('123', 'guild', 'ops');
  const result = await facade.resolveDiscordChannel(guildWith(fetched, [fetched]), '123', 'guild');
  assert.equal(result.discordChannel, fetched);
  assert.equal(result.channel.id, '123');
  assert.equal(result.channel.name, 'ops');

  const mentioned = await facade.resolveDiscordChannel(guildWith(fetched, [fetched]), '<#123>', 'guild');
  assert.equal(mentioned.discordChannel, fetched);
});

test('narrows collection-like direct fetch results before channel access', async () => {
  const directCollection = {
    id: '123',
    guildId: 'guild',
    name: 'ops',
    isTextBased: () => true,
    values: function* values() { yield channel('123', 'guild', 'ops'); }
  };
  await assert.rejects(
    () => emitted.resolveDiscordChannel(guildWith(directCollection, []), '123', 'guild')
  );
});

test('resolves names from array and Collection-like fetch results', async () => {
  const ops = channel('123', 'guild', 'ops');
  const dev = channel('456', 'guild', 'dev');
  const arrayResult = await emitted.resolveDiscordChannel(guildWith(dev, [ops, dev]), '#dev', 'guild');
  assert.equal(arrayResult.channel.id, '456');
  assert.equal(arrayResult.discordChannel, dev);

  const collection = { values: function* values() { yield ops; yield dev; } };
  const collectionResult = await emitted.resolveDiscordChannel(guildWith(dev, collection), 'ops', 'guild');
  assert.equal(collectionResult.channel.id, '123');
  assert.equal(collectionResult.discordChannel, ops);
});

test('rejects selectors outside the configured guild and non-message channels', async () => {
  const outside = channel('999', 'other-guild', 'ops');
  await assert.rejects(
    () => emitted.resolveDiscordChannel(guildWith(outside, [outside]), '999', 'guild'),
    /outside the configured guild/
  );

  const voice = channel('123', 'guild', 'voice', false);
  await assert.rejects(
    () => emitted.resolveDiscordChannel(guildWith(voice, [voice]), 'voice', 'guild'),
    /not message-capable/
  );
});

test('requires alternate selectors to identify the same channel', () => {
  const ops = { id: '123', guildId: 'guild', name: 'ops', messageCapable: true };
  assert.doesNotThrow(() => facade.assertSameChannelSelection(ops, '#ops', 'guild', [ops]));
  assert.throws(
    () => facade.assertSameChannelSelection(ops, '456', 'guild', [ops, { id: '456', guildId: 'guild', name: 'dev', messageCapable: true }]),
    /must identify the same channel/
  );
});

test('fails closed when emitted channel resolution is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-channel-resolution-missing-'));
  try {
    fs.mkdirSync(path.join(root, 'src', 'ordinary-bind'), { recursive: true });
    fs.copyFileSync(
      path.resolve(__dirname, '../src/ordinary-bind/channel-resolution.js'),
      path.join(root, 'src', 'ordinary-bind', 'channel-resolution.js')
    );
    const result = spawnSync(process.execPath, ['-e', "require('./src/ordinary-bind/channel-resolution')"], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run npm run build before starting/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
