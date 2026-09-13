'use strict';

try {
  module.exports = require('../../dist/discord/board-refresh.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/discord/board-refresh.js'")) throw error;
  throw new Error('discord-surface board refresh transport build is missing; run npm run build before starting', { cause: error });
}
