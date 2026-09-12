'use strict';

try {
  module.exports = require('../dist/discord-interaction.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/discord-interaction.js'")) throw error;
  throw new Error('discord-surface interaction build is missing; run npm run build before starting', { cause: error });
}
