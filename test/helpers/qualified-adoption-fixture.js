'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { PermissionFlagsBits } = require('discord.js');

const { SurfaceState } = require('../../src/state');

const WINDOW = { ViewChannel: PermissionFlagsBits.ViewChannel, ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeState(dir) {
  const state = new SurfaceState(path.join(dir, 'surface.sqlite'));
  state.setConfig({ operatorId: 'operator', guildId: 'guild', secretFile: path.join(dir, 'discord.env') });
  return state;
}

function grant(allowed = true) {
  return { has: () => allowed };
}

function adoptionChannel(id = 'chan', overrides = {}) {
  return {
    id,
    permissionsFor: () => grant(true),
    messages: { async fetch() { return new Map(); } },
    ...overrides
  };
}

async function refusalFrom(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('operation did not refuse');
}

async function withFakeDiscord(fake, run) {
  const originalLoad = Module._load;
  const discordPath = require.resolve('discord.js');
  const cached = require.cache[discordPath];
  const originalExports = cached?.exports;
  Module._load = (request, parent, isMain) => request === 'discord.js' ? fake : originalLoad(request, parent, isMain);
  if (cached) cached.exports = fake;
  try {
    return await run();
  } finally {
    Module._load = originalLoad;
    if (cached) cached.exports = originalExports;
  }
}

function fakeDiscordClient(channel, { user = { id: 'bot' } } = {}) {
  return class FakeClient {
    constructor() {
      this.user = user;
      this.guilds = {
        fetch: async () => ({
          channels: {
            fetch: async selection => selection ? channel : new Map([[channel.id, channel]])
          }
        })
      };
    }
    async listen() {}
    async login() {}
    async destroy() {}
  };
}

module.exports = {
  tempDir,
  makeState,
  grant,
  adoptionChannel,
  refusalFrom,
  withFakeDiscord,
  fakeDiscordClient
};
