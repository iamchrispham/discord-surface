'use strict';

try {
  module.exports = require('../dist/claude-channel.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/claude-channel.js'")) throw error;
  throw new Error('discord-surface Claude channel build is missing; run npm run build before starting', { cause: error });
}
